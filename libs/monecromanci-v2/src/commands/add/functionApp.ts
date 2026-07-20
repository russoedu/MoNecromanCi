import { join } from 'node:path'
import { runNx, runShell } from '../../nx'
import { readJson, toJson, writeFileEnsured } from '../../util/fsx'
import { logger } from '../../util/logger'
import { defaultScope, hasPlugin, type AddOptions } from './shared'

/**
 * Fails fast, with install instructions, when Azure Functions Core Tools is absent.
 *
 * @remarks
 * `@nxazure/func`'s generators shell out to the `func` CLI even at generation
 * time; without this preflight the user gets a raw "Command failed: func init"
 * with no hint of the actual requirement.
 *
 * @param workspaceRoot - Absolute path to the workspace (cwd for the probe).
 * @returns Nothing.
 * @throws Error when the `func` CLI is not on the PATH.
 * @typeParam None - this function has no generic type parameters.
 */
function ensureFunctionCoreTools (workspaceRoot: string): void {
  if (runShell('func', ['--version'], workspaceRoot) !== 0) {
    throw new Error('Azure Functions Core Tools not found. Install it first: npm install -g azure-functions-core-tools@4 --unsafe-perm true')
  }
}

/**
 * Ensures a plugin whose init generator needs arguments is plain-installed.
 *
 * @remarks
 * `@nxazure/func`'s init generator requires a name/directory, so `nx add`
 * (which runs it bare) always fails — install the package directly and let
 * {@link addFunctionApp} invoke the generators with the right arguments.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param packageName - The plugin package (e.g. `@nxazure/func`).
 * @returns Nothing.
 * @throws Error when npm install exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function ensurePackageInstalled (workspaceRoot: string, packageName: string): void {
  if (hasPlugin(workspaceRoot, packageName)) {
    return
  }
  logger.step(`Installing ${packageName}`)
  const status = runShell('npm', ['install', '--save-dev', packageName], workspaceRoot)
  if (status !== 0) {
    throw new Error(`npm install of ${packageName} failed with exit code ${status}`)
  }
}

/**
 * Builds an app's `package` target: zip the build output into the drop.
 *
 * @remarks
 * Produces `dist/drop/<type>-<name>.zip` from `buildOutDir` after `build`. The
 * zip's basename is exactly `<type>-<name>` — the string CI turns into a per-app
 * build tag (`##vso[build.addbuildtag]`), so the classic release pipeline keys
 * off the same name it deploys. The command is a single cross-platform
 * `node -e` (adm-zip), and `outputs` lets Nx cache the artifact.
 *
 * @param type - The app kind slug (currently only `function-app`).
 * @param name - The project name.
 * @param buildOutDirectory - The build output folder to zip, workspace-relative
 * (`dist/function-apps/<name>`).
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function appPackageTarget (type: 'function-app', name: string, buildOutDirectory: string): Record<string, unknown> {
  const zip = `dist/drop/${type}-${name}.zip`
  const command = `node -e "const fs=require('node:fs');fs.mkdirSync('dist/drop',{recursive:true});const A=require('adm-zip');const z=new A();z.addLocalFolder('${buildOutDirectory}');z.writeZip('${zip}')"`
  return {
    executor:  'nx:run-commands',
    dependsOn: ['build'],
    // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- {workspaceRoot} is an Nx output token, not a JS interpolation
    outputs:   [`{workspaceRoot}/${zip}`],
    options:   { command },
  }
}

/**
 * The bundle entry point written into every generated function app.
 *
 * @remarks
 * esbuild bundles from a single entry, so each function file must be imported
 * here — the one convention a function app carries: add an import per
 * function you create.
 */
export const FUNCTION_APP_MAIN = `// The bundle entry point: esbuild only includes what is reachable from here,
// so add one import per function file you create under src/functions/.
import './functions/hello.js'
`

/**
 * Replaces the plugin-generated build/run plumbing of a function app with an
 * esbuild single-file bundle.
 *
 * @remarks
 * `@nxazure/func`'s *generators* work on Nx 23, but all three of its
 * *executors* (`build`/`start`/`publish`) share a broken code path: their
 * `prepare-build.js` force-sets a relative `rootDir: '.'` into compiler
 * options that TypeScript already resolved to absolute paths, which the TS
 * shipped with Nx 23 rejects ("Paths must either both be absolute or both be
 * relative"). An Azure Function app is just a Node.js app packed with
 * `package.json` + `host.json`, so v2 keeps the plugin for generation and
 * rewires the build to the official `@nx/esbuild` executor, which emits a
 * fully self-contained deployable folder at `dist/function-apps/<name>`:
 * one `main.cjs` with every dependency (including private internal libs)
 * compiled in, plus `host.json` and `package.json` copied as assets. CI then
 * packages function apps with a plain artifact-publish step — no shell
 * scripting, no staged `npm install`.
 *
 * The bundle is CommonJS with `@azure/functions-core` left external: that
 * module is virtual — injected by the Functions host worker at run time — and
 * a leftover `require` of it only resolves in a CJS bundle.
 *
 * Repaired files:
 * - `package.json`: real name (the generator leaves it empty, which corrupts
 *   npm workspaces), `private: true`, `main: 'main.cjs'` — the manifest is
 *   copied into the bundle folder, where the Functions host reads it.
 * - `project.json`: `build` = `@nx/esbuild:esbuild`, `start` = `func start`
 *   run inside the bundle folder; the plugin's broken `publish` target is
 *   dropped — the CI artifact is the deployable.
 * - `src/main.ts`: the bundle entry ({@link FUNCTION_APP_MAIN}).
 * - `tsconfig.json`: the TS-solution base is declaration-only
 *   (`emitDeclarationOnly`/`composite`); the app must type-check as a plain
 *   emitting project (esbuild reads this tsconfig too).
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The function app's project name.
 * @param scope - The npm scope used for the app's package name.
 * @param testRunner - The workspace's chosen unit-test runner (jest or vitest).
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the app's files.
 * @typeParam None - this function has no generic type parameters.
 */
function repairFunctionApp (workspaceRoot: string, name: string, scope: string, testRunner: 'jest' | 'vitest'): void {
  const appRoot = join(workspaceRoot, 'apps', name)
  const rootManifest = readJson<{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }>(join(workspaceRoot, 'package.json'))
  const azureFunctionsVersion = rootManifest.dependencies?.['@azure/functions'] ?? rootManifest.devDependencies?.['@azure/functions'] ?? '^4.0.0'
  const outputPath = `dist/function-apps/${name}`

  writeFileEnsured(join(appRoot, 'package.json'), toJson({
    name:         `${scope}/${name}`,
    version:      '0.0.1',
    private:      true,
    main:         'main.cjs',
    dependencies: {
      '@azure/functions': azureFunctionsVersion,
    },
  }))

  writeFileEnsured(join(appRoot, 'src/main.ts'), FUNCTION_APP_MAIN)

  writeFileEnsured(join(appRoot, 'project.json'), toJson({
    name,
    $schema:     '../../node_modules/nx/schemas/project-schema.json',
    projectType: 'application',
    tags:        [],
    targets:     {
      build: {
        executor: '@nx/esbuild:esbuild',
        outputs:  ['{options.outputPath}'],
        options:  {
          main:                `apps/${name}/src/main.ts`,
          outputPath,
          outputFileName:      'main.js',
          tsConfig:            `apps/${name}/tsconfig.json`,
          bundle:              true,
          // Everything is compiled into the bundle except the virtual module
          // the Functions host injects at run time.
          thirdParty:          true,
          external:            ['@azure/functions-core'],
          platform:            'node',
          format:              ['cjs'],
          minify:              false,
          // Unsupported in TS-solution workspaces; the app's own manifest is
          // copied as an asset instead.
          generatePackageJson: false,
          assets:              [
            { glob: 'host.json', input: `apps/${name}`, output: '.' },
            { glob: 'package.json', input: `apps/${name}`, output: '.' },
            // Local dev only — gitignored, so it never reaches CI artifacts.
            { glob: 'local.settings.json', input: `apps/${name}`, output: '.' },
          ],
        },
      },
      start: {
        executor:  'nx:run-commands',
        dependsOn: ['build'],
        options:   { command: 'func start', cwd: outputPath },
      },
      // The plugin-generated kinds get their runner from --unitTestRunner; a
      // hand-rewired function app has none, so wire an explicit run of the
      // workspace's chosen runner (self-contained: reads the app's own config,
      // no root preset required).
      test: {
        executor: 'nx:run-commands',
        options:  { command: testRunner === 'vitest' ? 'vitest run --passWithNoTests' : 'jest', cwd: `apps/${name}` },
      },
      // Zip the self-contained bundle folder into the drop under the exact name
      // CI turns into a build tag (function-app-<name>). See appPackageTarget.
      package: appPackageTarget('function-app', name, outputPath),
    },
  }))

  writeFileEnsured(join(appRoot, 'tsconfig.json'), toJson({
    extends:         '../../tsconfig.base.json',
    compilerOptions: {
      outDir:              'dist',
      rootDir:             '.',
      strict:              true,
      composite:           false,
      declaration:         false,
      declarationMap:      false,
      emitDeclarationOnly: false,
      sourceMap:           true,
      types:               ['node'],
    },
    include: ['src/**/*.ts'],
    // Tests are type-checked under tsconfig.spec.json (which adds the jest
    // globals); keeping them out here stops the app's own build/editor pass
    // from flagging `describe`/`expect` as undefined.
    exclude: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
  }))

  if (testRunner === 'vitest') {
    // Vitest transforms with esbuild (no ts-jest, no module overrides needed);
    // the spec tsconfig only supplies the global test API types to the editor.
    writeFileEnsured(join(appRoot, 'tsconfig.spec.json'), toJson({
      extends:         './tsconfig.json',
      compilerOptions: { outDir: './out-tsc/vitest', composite: false, declaration: false, emitDeclarationOnly: false, types: ['vitest/globals', 'node'] },
      include:         ['src/**/*.spec.ts', 'src/**/*.test.ts', 'src/**/*.d.ts'],
    }))
    writeFileEnsured(join(appRoot, 'vitest.config.ts'), FUNCTION_APP_VITEST_CONFIG)
  } else {
    writeFileEnsured(join(appRoot, 'tsconfig.spec.json'), toJson({
      extends:         './tsconfig.json',
      compilerOptions: {
        // CommonJS keeps ts-jest's transform trivial (no ESM jest runner setup),
        // independent of whatever module/resolution the TS-solution base uses.
        // verbatimModuleSyntax + esModuleInterop are pinned so an ESM-strict base
        // (the `--preset=ts` default sets verbatimModuleSyntax) can't reject the
        // plain `import` syntax once module is overridden to commonjs here.
        // ignoreDeprecations silences TS6+'s node10-resolution deprecation error
        // (classic `node` resolution is what ts-jest wants for a commonjs run).
        module:               'commonjs',
        moduleResolution:     'node',
        ignoreDeprecations:   '6.0',
        verbatimModuleSyntax: false,
        esModuleInterop:      true,
        outDir:               './out-tsc/jest',
        composite:            false,
        declaration:          false,
        emitDeclarationOnly:  false,
        types:                ['jest', 'node'],
      },
      include: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'src/**/*.d.ts'],
    }))
    writeFileEnsured(join(appRoot, 'jest.config.mjs'), FUNCTION_APP_JEST_CONFIG(name))
  }

  writeFileEnsured(join(appRoot, 'src/greeting.ts'), FUNCTION_APP_GREETING)
  writeFileEnsured(join(appRoot, 'src/greeting.spec.ts'), FUNCTION_APP_GREETING_SPEC)
}

/**
 * The self-contained vitest config written into a function app on the vitest stack.
 *
 * @remarks
 * `globals: true` makes `describe`/`it`/`expect` ambient, so the same sample
 * spec works under either runner; vitest transforms TS via esbuild, so no
 * ts-jest and no tsconfig gymnastics are needed. `nx test` runs
 * `vitest run --passWithNoTests`, staying green after the sample is deleted.
 */
export const FUNCTION_APP_VITEST_CONFIG = `import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
  },
})
`

/**
 * Builds the self-contained jest config written into a function app.
 *
 * @remarks
 * A `.mjs` config so jest reads it with no `ts-node` (it is plain config, not
 * transformed); `ts-jest` transforms the test files themselves, driven by the
 * app's `tsconfig.spec.json`. `passWithNoTests` keeps `nx test` green after the
 * user deletes the sample spec.
 *
 * @param name - The function app's project name (jest's display name).
 * @returns The full text of the app's `jest.config.mjs`.
 * @throws Never - performs a pure string build with no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function FUNCTION_APP_JEST_CONFIG (name: string): string {
  return String.raw`export default {
  displayName: '${name}',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[cm]?[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'mjs', 'cjs'],
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/src/**/*.test.ts'],
  passWithNoTests: true,
}
`
}

/**
 * A sample pure helper written into every generated function app.
 *
 * @remarks
 * Gives the app a genuinely testable unit (the plugin-generated `hello`
 * handler needs `@azure/functions` mocking), so the wired-up jest target has a
 * real passing test out of the box. Delete it once you have your own.
 */
export const FUNCTION_APP_GREETING = `/** Builds the greeting returned by the sample HTTP function. */
export function buildGreeting (name: string): string {
  return 'Hello, ' + name + '!'
}
`

/**
 * The sample spec proving the function app's jest target runs.
 *
 * @remarks
 * Deliberately dependency-free (no Azure SDK), so it passes on a bare workspace.
 */
export const FUNCTION_APP_GREETING_SPEC = `import { buildGreeting } from './greeting'

describe('buildGreeting', () => {
  it('greets a name', () => {
    expect(buildGreeting('world')).toBe('Hello, world!')
  })
})
`

/**
 * Adds an Azure Function app: `@nxazure/func` generators, then a rewired esbuild build.
 *
 * @remarks
 * Preflights the `func` CLI (the generators shell out to it even at generation
 * time), generates via the plugin, then repairs the broken executors
 * ({@link repairFunctionApp}) and installs everything the repair needs in one
 * shot: the esbuild toolchain, the chosen test runner (a hand-rewired app
 * carries none from a plugin generator), and adm-zip for packaging.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @param options - The CLI flags (only `scope` is used).
 * @param testRunner - The workspace's chosen unit-test runner.
 * @returns Nothing.
 * @throws Error when Core Tools is missing, or any generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addFunctionApp (workspaceRoot: string, name: string, options: AddOptions, testRunner: 'jest' | 'vitest'): void {
  ensureFunctionCoreTools(workspaceRoot)
  ensurePackageInstalled(workspaceRoot, '@nxazure/func')
  runNx(['g', '@nxazure/func:init', name, `--directory=apps/${name}`, '--no-interactive'], workspaceRoot)
  // No shell quoting needed: runShell passes arguments as a real argv array
  // (cross-spawn), so a value with an embedded space stays one argv token.
  runNx(['g', '@nxazure/func:new', 'hello', `--project=${name}`, '--template=HTTP trigger'], workspaceRoot)
  repairFunctionApp(workspaceRoot, name, options.scope ?? defaultScope(workspaceRoot), testRunner)
  // One install materialises everything the repair introduced: the app's
  // @azure/functions dependency, the esbuild toolchain that bundles it, the
  // chosen test runner (function apps are rewired by hand, so — unlike the
  // plugin-generated kinds — they carry no test setup of their own until we
  // add one here), and adm-zip for the `package` target.
  const functionTestDependencies = testRunner === 'vitest' ? ['vitest'] : ['jest', 'ts-jest', '@types/jest']
  logger.step(`Installing the bundler (@nx/esbuild), ${testRunner} and packaging (adm-zip) toolchains and workspace dependencies`)
  if (runShell('npm', ['install', '--save-dev', '@nx/esbuild', 'esbuild', ...functionTestDependencies, 'adm-zip', '--no-audit', '--no-fund'], workspaceRoot) !== 0) {
    throw new Error('npm install after the function-app repair failed')
  }
}
