import { join } from 'node:path'
import { select } from '@inquirer/prompts'
import { quote, runNx, runShell } from '../nx'
import { promptText } from '../prompts'
import { fileExists, readJson, toJson, writeFileEnsured } from '../util/fsx'
import { logger } from '../util/logger'

/* The generator flags below are the plugins' own options; v2 adds no config
 * of its own on top of what @nx/react, @nx/js and @nxazure/func emit. */

/**
 * The project kinds v2 can add — deliberately just four.
 *
 * @remarks
 * Each maps to an official (or established community) Nx plugin generator;
 * v2 itself writes no project files. Layout convention drives release
 * scoping: `apps/` (never released), `packages/` (publishable, released by
 * `nx release`), `libs/` (internal, `private: true`, never released).
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type ProjectKind = 'react-app' | 'function-app' | 'npm-lib' | 'internal-lib'

/**
 * Every kind {@link runAdd} accepts, in menu order.
 *
 * @remarks
 * Also drives the interactive kind picker shown when `add` is run bare.
 */
export const PROJECT_KINDS: ProjectKind[] = ['react-app', 'function-app', 'npm-lib', 'internal-lib']

/**
 * Options accepted by {@link runAdd}.
 *
 * @remarks
 * Mirrors the CLI's flags.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface AddOptions {
  /** npm scope for a publishable lib's import path (defaults to `@<workspace name>`). */
  scope?: string
}

/**
 * Whether a plugin package is already declared in the workspace's manifest.
 *
 * @remarks
 * Keeps repeat `add` calls fast by skipping the install step.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param packageName - The plugin package (e.g. `@nx/react`).
 * @returns `true` when the package is a dependency or devDependency.
 * @throws Propagates any `fs`/JSON error reading the root manifest.
 * @typeParam None - this function has no generic type parameters.
 */
function hasPlugin (workspaceRoot: string, packageName: string): boolean {
  const manifest = readJson<{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }>(join(workspaceRoot, 'package.json'))
  const installed = { ...manifest.dependencies, ...manifest.devDependencies }
  return Object.hasOwn(installed, packageName)
}

/**
 * Ensures an Nx plugin is installed in the workspace, installing it on first use.
 *
 * @remarks
 * `nx add` installs the package and runs its init generator — the Nx-native
 * way to bring a plugin into an existing workspace.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param packageName - The plugin package (e.g. `@nx/react`).
 * @returns Nothing.
 * @throws Error when the underlying `nx add` exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function ensurePlugin (workspaceRoot: string, packageName: string): void {
  if (hasPlugin(workspaceRoot, packageName)) {
    return
  }
  logger.step(`Installing Nx plugin ${packageName}`)
  runNx(['add', packageName], workspaceRoot)
}

/**
 * Ensures a plugin whose init generator needs arguments is plain-installed.
 *
 * @remarks
 * `@nxazure/func`'s init generator requires a name/directory, so `nx add`
 * (which runs it bare) always fails — install the package directly and let
 * {@link runAdd} invoke the generators with the right arguments.
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
 * Adds a project to the workspace by delegating to the matching Nx generator.
 *
 * @remarks
 * Pure delegation — v2 performs no post-generation file rewriting, with one
 * tiny exception: an internal lib is marked `"private": true` so it can never
 * be published by accident. The known gap (same as v1): a *publishable* lib
 * importing a *private internal* lib cannot be published as-is; internal libs
 * are for apps and other internal libs.
 *
 * @param kind - The project kind, prompted for when omitted.
 * @param name - The project name, prompted for when omitted.
 * @param options - The CLI flags.
 * @returns A promise that resolves when the generator has finished.
 * @throws Error when run outside a workspace root or a generator fails.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runAdd (kind: ProjectKind | undefined, name: string | undefined, options: AddOptions): Promise<void> {
  const workspaceRoot = process.cwd()
  if (!fileExists(join(workspaceRoot, 'nx.json'))) {
    throw new Error('No nx.json found here. Run `add` from the workspace root.')
  }

  const resolvedKind = kind ?? await select<ProjectKind>({
    message: 'What kind of project?',
    choices: PROJECT_KINDS.map((value) => ({ name: value, value })),
  })
  const resolvedName = name ?? await promptText('Project name')

  switch (resolvedKind) {
    case 'react-app': {
      ensurePlugin(workspaceRoot, '@nx/react')
      runNx([
        'g', '@nx/react:app', `apps/${resolvedName}`,
        '--bundler=vite',
        '--unitTestRunner=jest',
        '--linter=eslint',
        '--style=css',
        '--e2eTestRunner=none',
        '--no-interactive',
      ], workspaceRoot)
      ensureAdmZip(workspaceRoot)
      // The Vite build emits to apps/<name>/dist (app-local `outDir: './dist'`);
      // the app is inference-only (no project.json), so the package target is
      // attached via the manifest's `nx` field.
      addNxPackageTarget(join(workspaceRoot, 'apps', resolvedName, 'package.json'), appPackageTarget('react-app', resolvedName, `apps/${resolvedName}/dist`))
      break
    }
    case 'function-app': {
      ensureFunctionCoreTools(workspaceRoot)
      ensurePackageInstalled(workspaceRoot, '@nxazure/func')
      runNx(['g', '@nxazure/func:init', resolvedName, `--directory=apps/${resolvedName}`, '--no-interactive'], workspaceRoot)
      runNx(['g', '@nxazure/func:new', 'hello', `--project=${resolvedName}`, `--template=${quote('HTTP trigger')}`], workspaceRoot)
      repairFunctionApp(workspaceRoot, resolvedName, options.scope ?? defaultScope(workspaceRoot))
      // One install materialises everything the repair introduced: the app's
      // @azure/functions dependency, the esbuild toolchain that bundles it, and
      // the jest toolchain its `test` target runs (function apps are rewired by
      // hand, so — unlike the plugin-generated kinds — they carry no jest setup
      // of their own until we add one here).
      // adm-zip is the packager the app's `package` target uses (see repairFunctionApp).
      logger.step('Installing the bundler (@nx/esbuild), jest and packaging (adm-zip) toolchains and workspace dependencies')
      if (runShell('npm', ['install', '--save-dev', '@nx/esbuild', 'esbuild', 'jest', 'ts-jest', '@types/jest', 'adm-zip', '--no-audit', '--no-fund'], workspaceRoot) !== 0) {
        throw new Error('npm install after the function-app repair failed')
      }
      break
    }
    case 'npm-lib': {
      const scope = options.scope ?? defaultScope(workspaceRoot)
      // rollup (not tsc): a bundler is what lets a published package depend on
      // private internal libs. @nx/rollup's withNx externalizes exactly the
      // manifest's dependencies/peerDependencies — so imported internal libs
      // (never declared in the manifest, npm workspaces links them regardless)
      // are compiled INTO the bundle from source, and the private name never
      // reaches the published package.json.
      runNx([
        'g', '@nx/js:lib', `packages/${resolvedName}`,
        '--publishable',
        `--importPath=${scope}/${resolvedName}`,
        '--bundler=rollup',
        '--unitTestRunner=jest',
        '--linter=eslint',
        '--no-interactive',
      ], workspaceRoot)
      writeFileEnsured(join(workspaceRoot, 'packages', resolvedName, 'eslint.config.mjs'), NPM_LIB_ESLINT_CONFIG)
      break
    }
    case 'internal-lib': {
      // tsc (not none): the default @nx/enforce-module-boundaries rule forbids
      // buildable libraries (every npm-lib) from importing non-buildable ones,
      // so internal libs must be buildable — just never published (private).
      runNx([
        'g', '@nx/js:lib', `libs/${resolvedName}`,
        '--bundler=tsc',
        '--unitTestRunner=jest',
        '--linter=eslint',
        '--no-interactive',
      ], workspaceRoot)
      markPrivate(join(workspaceRoot, 'libs', resolvedName, 'package.json'))
      break
    }
  }

  syncProjectReferences(workspaceRoot)

  logger.success(`Added ${resolvedKind} '${resolvedName}'.`)
}

/**
 * Regenerates the workspace's TypeScript project references via `nx sync`.
 *
 * @remarks
 * The `--preset=ts` model resolves cross-project imports through TypeScript
 * project references, and those references are maintained by `nx sync` — not
 * by the generators. Without this, a freshly added project's references are
 * stale, so an editor (and a plain `tsc`) cannot resolve `@scope/lib` imports
 * between projects until the user runs `nx sync` by hand: the missing step
 * that leaves VSCode unable to autocomplete across libraries. Run once after
 * every `add` so cross-project imports resolve immediately.
 *
 * Non-fatal: the project is already generated by the time this runs, so a sync
 * failure only warns (with the manual command) rather than failing the whole
 * `add` and leaving the user unsure whether their project was created.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Never - a non-zero `nx sync` is reported as a warning, not thrown.
 * @typeParam None - this function has no generic type parameters.
 */
function syncProjectReferences (workspaceRoot: string): void {
  logger.step('Syncing TypeScript project references (nx sync)')
  if (runShell('npx', ['nx', 'sync'], workspaceRoot) !== 0) {
    logger.warn('nx sync did not complete — run `npx nx sync` yourself so cross-project imports resolve in your editor.')
  }
}

/**
 * Ensures the `adm-zip` packager is a workspace devDependency.
 *
 * @remarks
 * Each app's `package` target zips its build output with `adm-zip` (pure JS,
 * cross-platform, no native build) so CI can pack apps on any agent OS. The
 * function-app path folds it into its larger install; the react path installs
 * it here on first use.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Error when the install exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function ensureAdmZip (workspaceRoot: string): void {
  if (hasPlugin(workspaceRoot, 'adm-zip')) {
    return
  }
  logger.step('Installing the app packager (adm-zip)')
  if (runShell('npm', ['install', '--save-dev', 'adm-zip', '--no-audit', '--no-fund'], workspaceRoot) !== 0) {
    throw new Error('npm install of adm-zip failed')
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
 * @param type - The app kind slug (`function-app` | `react-app`).
 * @param name - The project name.
 * @param buildOutDir - The build output folder to zip, workspace-relative
 * (function apps: `dist/function-apps/<name>`; react apps: `apps/<name>/dist`).
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function appPackageTarget (type: 'function-app' | 'react-app', name: string, buildOutDirectory: string): Record<string, unknown> {
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
 * Adds a `package` target to an inference-only app via its manifest `nx` field.
 *
 * @remarks
 * React apps generated by `@nx/react:app` have no `project.json` (targets are
 * inferred), so the extra target is attached through the package.json `nx`
 * field — merged with the inferred targets, and free of the project-name
 * clash a second `project.json` would risk in a TS-solution workspace.
 *
 * @param manifestPath - Absolute path to the app's `package.json`.
 * @param target - The target object from {@link appPackageTarget}.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
function addNxPackageTarget (manifestPath: string, target: Record<string, unknown>): void {
  // The generator always writes this manifest first (runAdd throws otherwise);
  // defaulting to {} only guards the pathological missing-file case.
  const manifest = fileExists(manifestPath) ? readJson<Record<string, unknown>>(manifestPath) : {}
  const nx = (manifest.nx as Record<string, unknown> | undefined) ?? {}
  const targets = (nx.targets as Record<string, unknown> | undefined) ?? {}
  writeFileEnsured(manifestPath, toJson({ ...manifest, nx: { ...nx, targets: { ...targets, package: target } } }))
}

/**
 * Derives the default npm scope from the workspace's root package name.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The scope, e.g. `@demo` for a workspace named `demo` (or
 * `@demo/source`-style names produced by some presets).
 * @throws Propagates any `fs`/JSON error reading the root manifest.
 * @typeParam None - this function has no generic type parameters.
 */
function defaultScope (workspaceRoot: string): string {
  const { name } = readJson<{ name: string }>(join(workspaceRoot, 'package.json'))
  const base = (name.startsWith('@') ? name.slice(1) : name).split('/', 1)[0]
  return `@${base}`
}

/**
 * Sets `"private": true` in a package manifest.
 *
 * @remarks
 * One of the deliberate post-generation touches: it makes internal
 * libraries structurally unpublishable, no matter what future config drifts.
 *
 * @param manifestPath - Absolute path to the lib's `package.json`.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
function markPrivate (manifestPath: string): void {
  const manifest = readJson<Record<string, unknown>>(manifestPath)
  writeFileEnsured(manifestPath, toJson({ ...manifest, private: true }))
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
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the app's files.
 * @typeParam None - this function has no generic type parameters.
 */
function repairFunctionApp (workspaceRoot: string, name: string, scope: string): void {
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
      // The plugin-generated kinds get jest from their `--unitTestRunner=jest`
      // generator; a hand-rewired function app has none, so wire an explicit
      // jest run (self-contained: reads the app's own jest.config.mjs, no root
      // preset required) rather than leaning on plugin inference that only
      // exists once some other jest-using project has been added.
      test: {
        executor: 'nx:run-commands',
        options:  { command: 'jest', cwd: `apps/${name}` },
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
  writeFileEnsured(join(appRoot, 'src/greeting.ts'), FUNCTION_APP_GREETING)
  writeFileEnsured(join(appRoot, 'src/greeting.spec.ts'), FUNCTION_APP_GREETING_SPEC)
}

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
 * The per-npm-lib ESLint config written over the generator's default.
 *
 * @remarks
 * Identical to what `@nx/js:lib --bundler=rollup` generates, plus ONE
 * addition: `@nx/dependency-checks` gets an `ignoredDependencies` list of
 * every `private: true` workspace package, computed at lint time. Private
 * libs are compiled INTO the rollup bundle and never declared in the
 * manifest (a consumer could not install them) — without this, the rule
 * flags every internal-lib import as a missing dependency. Because the list
 * is computed, adding a new internal lib never requires touching this file.
 */
export const NPM_LIB_ESLINT_CONFIG = `import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import baseConfig from '../../eslint.config.mjs';

// Private workspace libs are compiled INTO this package's rollup bundle and
// never declared in the manifest (a consumer could not install them), so the
// dependency check must ignore them. Computed at lint time: adding a new
// internal lib never requires touching this file.
const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const privateWorkspacePackages = globSync(['libs/*/package.json', 'packages/*/package.json'], { cwd: workspaceRoot })
  .map((manifestPath) => JSON.parse(readFileSync(join(workspaceRoot, manifestPath), 'utf8')))
  .filter((manifest) => manifest.private === true)
  .map((manifest) => manifest.name);

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredDependencies: privateWorkspacePackages,
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
            '{projectRoot}/rollup.config.{js,ts,mjs,mts,cjs,cts}',
          ],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
  {
    ignores: ['**/out-tsc'],
  },
];
`
