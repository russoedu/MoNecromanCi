import { readFileSync } from 'node:fs'
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
 * v2 itself writes no project files (bar thin overlays). Layout convention
 * drives release scoping: `apps/` (never released), `packages/` (publishable
 * npm, released by `nx release`), `libs/` (internal, never released),
 * `python-packages/` (publishable Python, published by `uv`).
 *
 * The TS/JS kinds use the official `@nx/*` (and `@nxazure/func`) generators; the
 * Python kinds use the community-standard [`@nxlv/python`](https://github.com/lucasvieirasilva/nx-plugins)
 * with **uv + Ruff + pytest** — the industry-standard Python toolchain.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type ProjectKind
  = | 'react-app' | 'function-app' | 'npm-lib' | 'internal-lib'
    | 'python-app' | 'python-function-app' | 'python-lib' | 'python-internal-lib'

/**
 * Every kind {@link runAdd} accepts, in menu order.
 *
 * @remarks
 * Also drives the interactive kind picker shown when `add` is run bare. TS/JS
 * kinds first, then the Python family.
 */
export const PROJECT_KINDS: ProjectKind[] = [
  'react-app', 'function-app', 'npm-lib', 'internal-lib',
  'python-app', 'python-function-app', 'python-lib', 'python-internal-lib',
]

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

  // The stack chosen at `mnci2 new` lives in nx.json; every generator (and the
  // hand-built function app) is wired to match it.
  const stack = readWorkspaceStack(workspaceRoot)

  // When the kind was not passed, the user is on the bare/interactive path, so
  // fill in every configuration — including the npm-lib scope (below) that the
  // flag path defaults silently.
  const kindProvided = kind !== undefined
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
        `--unitTestRunner=${stack.testRunner}`,
        `--linter=${stack.linter}`,
        '--style=css',
        '--e2eTestRunner=none',
        '--no-interactive',
      ], workspaceRoot)
      ensureAdmZip(workspaceRoot)
      // A React SPA bakes its VITE_ config in at build time, so it is built once
      // per environment. Scaffold a .env.<env> per environment and attach the
      // per-env build + packaging targets (the app is inference-only, so via the
      // manifest's `nx` field). Each env produces its own dist/drop zip + tag.
      const reactAppRoot = join(workspaceRoot, 'apps', resolvedName)
      for (const environment of REACT_ENVIRONMENTS) {
        writeFileEnsured(join(reactAppRoot, `.env.${environment}`), reactEnvironmentFile(environment))
      }
      allowEnvFiles(workspaceRoot)
      addNxTargets(join(reactAppRoot, 'package.json'), reactAppTargets(resolvedName))
      break
    }
    case 'function-app': {
      ensureFunctionCoreTools(workspaceRoot)
      ensurePackageInstalled(workspaceRoot, '@nxazure/func')
      runNx(['g', '@nxazure/func:init', resolvedName, `--directory=apps/${resolvedName}`, '--no-interactive'], workspaceRoot)
      runNx(['g', '@nxazure/func:new', 'hello', `--project=${resolvedName}`, `--template=${quote('HTTP trigger')}`], workspaceRoot)
      repairFunctionApp(workspaceRoot, resolvedName, options.scope ?? defaultScope(workspaceRoot), stack.testRunner)
      // One install materialises everything the repair introduced: the app's
      // @azure/functions dependency, the esbuild toolchain that bundles it, the
      // chosen test runner (function apps are rewired by hand, so — unlike the
      // plugin-generated kinds — they carry no test setup of their own until we
      // add one here), and adm-zip for the `package` target.
      const functionTestDependencies = stack.testRunner === 'vitest' ? ['vitest'] : ['jest', 'ts-jest', '@types/jest']
      logger.step(`Installing the bundler (@nx/esbuild), ${stack.testRunner} and packaging (adm-zip) toolchains and workspace dependencies`)
      if (runShell('npm', ['install', '--save-dev', '@nx/esbuild', 'esbuild', ...functionTestDependencies, 'adm-zip', '--no-audit', '--no-fund'], workspaceRoot) !== 0) {
        throw new Error('npm install after the function-app repair failed')
      }
      break
    }
    case 'npm-lib': {
      const scope = options.scope ?? (kindProvided
        ? defaultScope(workspaceRoot)
        : await promptText('npm scope for the published package', defaultScope(workspaceRoot)))
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
        `--unitTestRunner=${stack.testRunner}`,
        `--linter=${stack.linter}`,
        '--no-interactive',
      ], workspaceRoot)
      // The dependency-check override is an ESLint config; oxlint has no such
      // rule, so it only applies when ESLint is the chosen linter.
      if (stack.linter === 'eslint') {
        writeFileEnsured(join(workspaceRoot, 'packages', resolvedName, 'eslint.config.mjs'), NPM_LIB_ESLINT_CONFIG)
      }
      break
    }
    case 'internal-lib': {
      // tsc (not none): the default @nx/enforce-module-boundaries rule forbids
      // buildable libraries (every npm-lib) from importing non-buildable ones,
      // so internal libs must be buildable — just never published (private).
      runNx([
        'g', '@nx/js:lib', `libs/${resolvedName}`,
        '--bundler=tsc',
        `--unitTestRunner=${stack.testRunner}`,
        `--linter=${stack.linter}`,
        '--no-interactive',
      ], workspaceRoot)
      markPrivate(join(workspaceRoot, 'libs', resolvedName, 'package.json'))
      break
    }
    case 'python-app': {
      preparePython(workspaceRoot)
      runUvProject(workspaceRoot, { name: resolvedName, directory: `apps/${resolvedName}`, projectType: 'application' })
      ensureAdmZip(workspaceRoot)
      // Python apps carry a real project.json, so the packaging target goes
      // straight in it (not the manifest `nx` field the inference-only TS apps
      // use). The build target emits a wheel to apps/<name>/dist; zip that into
      // the drop under the exact name CI turns into a build tag.
      addProjectJsonTargets(join(workspaceRoot, 'apps', resolvedName, 'project.json'), { package: pythonAppPackageTarget(resolvedName) })
      break
    }
    case 'python-function-app': {
      preparePython(workspaceRoot)
      runUvProject(workspaceRoot, { name: resolvedName, directory: `apps/${resolvedName}`, projectType: 'application' })
      // The plugin scaffolds a plain package; overlay the Azure Functions v2
      // shape (function_app.py + host.json + requirements.txt) and a pure,
      // pytest-covered helper in the module. The deployable is the source zip,
      // not the wheel, so `package` zips those files (func CLI not needed).
      const pythonFunctionAppRoot = join(workspaceRoot, 'apps', resolvedName)
      const moduleDirectory = pythonModuleDirectory(join(pythonFunctionAppRoot, 'project.json'), resolvedName)
      writeFileEnsured(join(pythonFunctionAppRoot, 'function_app.py'), pythonFunctionAppMain(moduleDirectory))
      writeFileEnsured(join(pythonFunctionAppRoot, 'host.json'), PYTHON_FUNCTION_APP_HOST_JSON)
      writeFileEnsured(join(pythonFunctionAppRoot, 'requirements.txt'), PYTHON_FUNCTION_APP_REQUIREMENTS)
      writeFileEnsured(join(pythonFunctionAppRoot, moduleDirectory, 'greeting.py'), PYTHON_FUNCTION_APP_GREETING)
      writeFileEnsured(join(pythonFunctionAppRoot, 'tests', 'test_greeting.py'), pythonFunctionAppGreetingTest(moduleDirectory))
      ensureAdmZip(workspaceRoot)
      addProjectJsonTargets(join(pythonFunctionAppRoot, 'project.json'), { package: pythonFunctionAppPackageTarget(resolvedName, moduleDirectory) })
      break
    }
    case 'python-lib': {
      preparePython(workspaceRoot)
      // Publishable → python-packages/ (a dir the npm `nx release` never globs,
      // so its proven flow is untouched). --publishable adds the plugin's
      // release hook; we also add a plain `publish` target so CI can publish
      // Python independently with `nx run-many -t publish` + uv env auth.
      runUvProject(workspaceRoot, { name: resolvedName, directory: `python-packages/${resolvedName}`, projectType: 'library', publishable: true })
      addProjectJsonTargets(join(workspaceRoot, 'python-packages', resolvedName, 'project.json'), { publish: pythonPublishTarget() })
      break
    }
    case 'python-internal-lib': {
      // Not publishable (no --publishable → no release hook), so it is
      // structurally never released; the plugin bundles it into consumers'
      // wheels (bundleLocalDependencies) the way an internal-lib is compiled in.
      preparePython(workspaceRoot)
      runUvProject(workspaceRoot, { name: resolvedName, directory: `libs/${resolvedName}`, projectType: 'library' })
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
 * The deploy environments each React app is built for.
 *
 * @remarks
 * A React SPA bakes its `VITE_*` config in at build time, so one build per
 * environment is needed. These are the three the generator scaffolds.
 */
export const REACT_ENVIRONMENTS = ['dev', 'uat', 'prod'] as const

/**
 * The `.env.<environment>` file scaffolded into a React app.
 *
 * @remarks
 * `vite build --mode <environment>` loads this file and compiles its `VITE_`
 * vars into that environment's bundle. Because those values ship to the
 * browser they are inherently public, so committing them (rather than sourcing
 * secrets) is correct — real secrets never belong in a client bundle.
 *
 * @param environment - The environment name (`dev` | `uat` | `prod`).
 * @returns The `.env.<environment>` file contents.
 * @throws Never - pure string build.
 * @typeParam None - this function has no generic type parameters.
 */
export function reactEnvironmentFile (environment: string): string {
  return `# Vite compiles VITE_-prefixed vars into the '${environment}' bundle at build time.
# They ship to the browser, so keep only PUBLIC config here — never secrets.
VITE_ENVIRONMENT=${environment}
VITE_API_URL=https://api.${environment}.example.com
`
}

/**
 * The per-environment build + packaging targets for a React app.
 *
 * @remarks
 * One `build-<env>` target per {@link REACT_ENVIRONMENTS} entry runs
 * `vite build --mode <env> --outDir dist-<env>`, so each environment gets its
 * own compiled-in `VITE_*` config. The `package` target depends on all three
 * and zips each `dist-<env>` into `dist/drop/react-app-<name>-<env>.zip` — one
 * artifact per environment. CI needs no change: the "tag per app" step derives
 * `##vso[build.addbuildtag]react-app-<name>-<env>` straight from the zip
 * filenames, so a classic release pipeline can deploy each environment from its
 * own artifact + tag. The inference-only `build` (default mode) stays for local
 * `nx build` and the CI verify step.
 *
 * @param name - The React app's project name.
 * @returns The Nx targets to merge into the app manifest's `nx` field.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
export function reactAppTargets (name: string): Record<string, unknown> {
  const targets: Record<string, unknown> = {}
  for (const environment of REACT_ENVIRONMENTS) {
    targets[`build-${environment}`] = {
      executor: 'nx:run-commands',
      // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- {workspaceRoot} is an Nx output token
      outputs:  [`{workspaceRoot}/apps/${name}/dist-${environment}`],
      options:  { command: `vite build --mode ${environment} --outDir dist-${environment}`, cwd: `apps/${name}` },
    }
  }
  const zipStatements = REACT_ENVIRONMENTS
    .map((environment) => `z=new A();z.addLocalFolder('apps/${name}/dist-${environment}');z.writeZip('dist/drop/react-app-${name}-${environment}.zip')`)
    .join(';')
  targets.package = {
    executor:  'nx:run-commands',
    dependsOn: REACT_ENVIRONMENTS.map((environment) => `build-${environment}`),
    // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- {workspaceRoot} tokens, not JS interpolation
    outputs:   REACT_ENVIRONMENTS.map((environment) => `{workspaceRoot}/dist/drop/react-app-${name}-${environment}.zip`),
    options:   { command: `node -e "const fs=require('node:fs');fs.mkdirSync('dist/drop',{recursive:true});const A=require('adm-zip');let z;${zipStatements}"` },
  }
  return targets
}

/**
 * Ensures the committed per-environment `.env.<env>` files are not gitignored.
 *
 * @remarks
 * The `.env.<env>` files hold public config and are meant to be versioned, but
 * some presets ignore `.env*`. This appends an idempotent allow-block to the
 * root `.gitignore` so `apps/<app>/.env.<env>` stays tracked regardless (a
 * no-op when nothing ignored them). File-level negation works because the
 * parent `apps/<app>` directory is never ignored.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Propagates any `fs` error reading or writing `.gitignore`.
 * @typeParam None - this function has no generic type parameters.
 */
function allowEnvFiles (workspaceRoot: string): void {
  const gitignorePath = join(workspaceRoot, '.gitignore')
  if (!fileExists(gitignorePath)) {
    return
  }
  const marker = '# MoNecromanCI: keep the committed per-environment Vite config (public VITE_ values)'
  const current = readFileSync(gitignorePath, 'utf8')
  if (current.includes(marker)) {
    return
  }
  const allow = REACT_ENVIRONMENTS.map((environment) => `!apps/*/.env.${environment}`).join('\n')
  writeFileEnsured(gitignorePath, `${current.replace(/\n*$/, '\n')}\n${marker}\n${allow}\n`)
}

/**
 * Merges extra Nx targets into an inference-only app via its manifest `nx` field.
 *
 * @remarks
 * React apps generated by `@nx/react:app` have no `project.json` (targets are
 * inferred), so extra targets (the per-environment builds and the `package`
 * target) are attached through the package.json `nx` field — merged with the
 * inferred targets, and free of the project-name clash a second `project.json`
 * would risk in a TS-solution workspace.
 *
 * @param manifestPath - Absolute path to the app's `package.json`.
 * @param newTargets - The targets to merge in (e.g. from {@link reactAppTargets}).
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
function addNxTargets (manifestPath: string, newTargets: Record<string, unknown>): void {
  // The generator always writes this manifest first (runAdd throws otherwise);
  // defaulting to {} only guards the pathological missing-file case.
  const manifest = fileExists(manifestPath) ? readJson<Record<string, unknown>>(manifestPath) : {}
  const nx = (manifest.nx as Record<string, unknown> | undefined) ?? {}
  const targets = (nx.targets as Record<string, unknown> | undefined) ?? {}
  writeFileEnsured(manifestPath, toJson({ ...manifest, nx: { ...nx, targets: { ...targets, ...newTargets } } }))
}

/**
 * The workspace stack, read back from the `nx.json` generator defaults `new` wrote.
 *
 * @remarks
 * How a one-time `mnci2 new` choice reaches `add`: the `linter`/`unitTestRunner`
 * defaults are the source of truth. `add` passes them back to the `@nx/*`
 * generators explicitly (predictable regardless of Nx's default resolution) and
 * uses the runner to wire the hand-built function app. `linter` is the
 * generator value — `eslint`, or `none` when the workspace chose oxlint.
 * Missing/blank defaults fall back to the box-out opinion (eslint + jest).
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The linter and test runner to apply.
 * @throws Propagates any `fs`/JSON error reading `nx.json`.
 * @typeParam None - this function has no generic type parameters.
 */
function readWorkspaceStack (workspaceRoot: string): { linter: 'eslint' | 'none', testRunner: 'jest' | 'vitest' } {
  const nxJson = readJson<{ generators?: Record<string, { linter?: string, unitTestRunner?: string }> }>(join(workspaceRoot, 'nx.json'))
  const defaults = nxJson.generators?.['@nx/js:library']
  return {
    linter:     defaults?.linter === 'none' ? 'none' : 'eslint',
    testRunner: defaults?.unitTestRunner === 'vitest' ? 'vitest' : 'jest',
  }
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

/* ---------------------------------------------------------------------------
 * Python (@nxlv/python — uv + Ruff + pytest)
 * ------------------------------------------------------------------------- */

/**
 * Preflight + plugin bootstrap shared by every Python kind.
 *
 * @remarks
 * Fails fast (with install hints) when `python`/`uv` are absent — Python
 * generation, unlike the TS function app's `func`, needs no extra CLI beyond
 * these — then ensures the `@nxlv/python` plugin is installed and registered.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Error when Python or uv is missing, or plugin install fails.
 * @typeParam None - this function has no generic type parameters.
 */
function preparePython (workspaceRoot: string): void {
  ensurePython(workspaceRoot)
  ensurePythonPlugin(workspaceRoot)
}

/**
 * Fails fast, with install hints, when Python or uv is not on the PATH.
 *
 * @param workspaceRoot - Absolute path to the workspace (cwd for the probes).
 * @returns Nothing.
 * @throws Error when `python3`/`python` or `uv` cannot be run.
 * @typeParam None - this function has no generic type parameters.
 */
function ensurePython (workspaceRoot: string): void {
  const hasPython = runShell('python3', ['--version'], workspaceRoot) === 0 || runShell('python', ['--version'], workspaceRoot) === 0
  if (!hasPython) {
    throw new Error('Python not found. Install Python 3.9+ first: https://www.python.org/downloads/')
  }
  if (runShell('uv', ['--version'], workspaceRoot) !== 0) {
    throw new Error('uv not found. Install it first: https://docs.astral.sh/uv/getting-started/installation/')
  }
}

/**
 * Ensures `@nxlv/python` is installed and registered in `nx.json` with uv.
 *
 * @remarks
 * `nx add @nxlv/python` installs the package but (unlike `@nx/*`) does not add
 * it to `nx.json`'s `plugins`, and its default package manager is Poetry with
 * no `uv.lock` in a `--preset=ts` repo to auto-detect uv. So after install we
 * register `{ plugin: '@nxlv/python', options: { packageManager: 'uv' } }`
 * ourselves (idempotently) — the single source of the uv choice for every
 * later Python `add`.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Error when `nx add` exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function ensurePythonPlugin (workspaceRoot: string): void {
  if (!hasPlugin(workspaceRoot, '@nxlv/python')) {
    logger.step('Installing Nx plugin @nxlv/python (uv + Ruff + pytest)')
    runNx(['add', '@nxlv/python'], workspaceRoot)
  }
  const nxJsonPath = join(workspaceRoot, 'nx.json')
  const nxJson = readJson<Record<string, unknown>>(nxJsonPath)
  const plugins = (nxJson.plugins as unknown[] | undefined) ?? []
  const registered = plugins.some((plugin) =>
    plugin === '@nxlv/python' || (typeof plugin === 'object' && plugin !== null && (plugin as { plugin?: string }).plugin === '@nxlv/python'))
  if (registered) {
    return
  }
  plugins.push({ plugin: '@nxlv/python', options: { packageManager: 'uv' } })
  writeFileEnsured(nxJsonPath, toJson({ ...nxJson, plugins }))
}

/**
 * Arguments for {@link runUvProject}.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
interface UvProjectSpec {
  /** Project name (Nx project name). */
  name:         string
  /** Workspace-relative directory the project is placed in (as-provided). */
  directory:    string
  /** `application` (apps) or `library` (packages/libs). */
  projectType:  'application' | 'library'
  /** Adds the plugin's release/publish hook. */
  publishable?: boolean
}

/**
 * Generates a Python project with the fixed mnci2 toolchain (Ruff + pytest + uv).
 *
 * @remarks
 * Python has no stack knob — Ruff and pytest are the industry standard and the
 * plugin's own defaults, so they are always passed explicitly (predictable
 * regardless of the plugin's default resolution). `buildSystem=hatch` yields a
 * PEP 517 wheel; `bundleLocalDependencies` (the plugin default) compiles
 * imported internal libs into that wheel.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param spec - The project name, directory, type and publishability.
 * @returns Nothing.
 * @throws Error when the generator exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function runUvProject (workspaceRoot: string, spec: UvProjectSpec): void {
  runNx([
    'g', '@nxlv/python:uv-project', spec.name,
    `--directory=${spec.directory}`,
    `--projectType=${spec.projectType}`,
    ...(spec.publishable ? ['--publishable'] : []),
    '--linter=ruff',
    '--unitTestRunner=pytest',
    '--buildSystem=hatch',
    '--no-interactive',
  ], workspaceRoot)
}

/**
 * Merges extra targets into a plugin-written `project.json`.
 *
 * @remarks
 * Python projects (unlike the inference-only TS apps that use {@link addNxTargets}
 * on the manifest `nx` field) carry a real `project.json`, so packaging/publish
 * targets are merged straight into its `targets`.
 *
 * @param projectJsonPath - Absolute path to the project's `project.json`.
 * @param newTargets - The targets to merge in.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the file.
 * @typeParam None - this function has no generic type parameters.
 */
function addProjectJsonTargets (projectJsonPath: string, newTargets: Record<string, unknown>): void {
  const project = readJson<Record<string, unknown>>(projectJsonPath)
  const targets = (project.targets as Record<string, unknown> | undefined) ?? {}
  writeFileEnsured(projectJsonPath, toJson({ ...project, targets: { ...targets, ...newTargets } }))
}

/**
 * Reads a Python project's module directory name from its `project.json`.
 *
 * @remarks
 * The plugin names the module dir from the project name (hyphens → underscores),
 * exposed as `sourceRoot` (e.g. `apps/my-svc/my_svc`). Reading it back is exact;
 * the `name`-derived value is only a fallback.
 *
 * @param projectJsonPath - Absolute path to the project's `project.json`.
 * @param name - The project name (fallback source of the module name).
 * @returns The module directory's basename (e.g. `my_svc`).
 * @throws Propagates any `fs`/JSON error reading the file.
 * @typeParam None - this function has no generic type parameters.
 */
function pythonModuleDirectory (projectJsonPath: string, name: string): string {
  const project = readJson<{ sourceRoot?: string }>(projectJsonPath)
  return project.sourceRoot?.split('/').pop() ?? name.replaceAll('-', '_')
}

/**
 * The `package` target for a Python app: zip its built wheel into the drop.
 *
 * @remarks
 * Zips `apps/<name>/dist` (the `@nxlv/python:build` wheel + sdist) into
 * `dist/drop/python-app-<name>.zip` — basename exactly `python-app-<name>`, the
 * string CI turns into the per-app build tag. `dependsOn: build` guarantees the
 * wheel exists; same cross-platform `adm-zip` one-liner as {@link appPackageTarget}.
 *
 * @param name - The Python app's project name.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function pythonAppPackageTarget (name: string): Record<string, unknown> {
  const zip = `dist/drop/python-app-${name}.zip`
  const command = `node -e "const fs=require('node:fs');fs.mkdirSync('dist/drop',{recursive:true});const A=require('adm-zip');const z=new A();z.addLocalFolder('apps/${name}/dist');z.writeZip('${zip}')"`
  return {
    executor:  'nx:run-commands',
    dependsOn: ['build'],
    // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- {workspaceRoot} is an Nx output token
    outputs:   [`{workspaceRoot}/${zip}`],
    options:   { command },
  }
}

/**
 * The `package` target for a Python Azure Function: zip the deploy folder.
 *
 * @remarks
 * An Azure Functions Python app is deployed as **source** (the host installs
 * `requirements.txt` and runs `function_app.py`), not as a wheel — so this zips
 * `function_app.py` + `host.json` + `requirements.txt` + the module package into
 * `dist/drop/python-function-app-<name>.zip`. Basename exactly
 * `python-function-app-<name>` (the CI build tag). No `build` dependency (the
 * artifact is source), same `adm-zip` one-liner.
 *
 * @param name - The function app's project name.
 * @param moduleDirectory - The app's Python module directory basename.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function pythonFunctionAppPackageTarget (name: string, moduleDirectory: string): Record<string, unknown> {
  const zip = `dist/drop/python-function-app-${name}.zip`
  const root = `apps/${name}`
  const command = `node -e "const fs=require('node:fs');fs.mkdirSync('dist/drop',{recursive:true});const A=require('adm-zip');const z=new A();z.addLocalFile('${root}/function_app.py');z.addLocalFile('${root}/host.json');z.addLocalFile('${root}/requirements.txt');z.addLocalFolder('${root}/${moduleDirectory}','${moduleDirectory}');z.writeZip('${zip}')"`
  return {
    executor: 'nx:run-commands',
    // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- {workspaceRoot} is an Nx output token
    outputs:  [`{workspaceRoot}/${zip}`],
    options:  { command },
  }
}

/**
 * The `publish` target added to a publishable Python package.
 *
 * @remarks
 * A thin `@nxlv/python:publish` (which runs `uv publish` after `build`), kept
 * separate from the plugin's `nx-release-publish` hook so CI can publish Python
 * with a plain `nx run-many -t publish` — decoupled from the npm `nx release`.
 * The upload URL and credentials come from `UV_PUBLISH_*` env in CI (the
 * executor's `repository` option does not set the uv publish URL), so no
 * registry coordinates are baked into the target.
 *
 * @returns The publish target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function pythonPublishTarget (): Record<string, unknown> {
  return { executor: '@nxlv/python:publish', outputs: [], options: { buildTarget: 'build' } }
}

/**
 * The Azure Functions v2 entry written into a generated Python function app.
 *
 * @remarks
 * The Python v2 programming model: a module-level `func.FunctionApp()` with
 * decorated routes. The handler is thin — the testable logic lives in the
 * module's `greeting.py` (imported here), so pytest needs no `azure-functions`
 * install. Anonymous auth keeps the sample runnable locally with `func start`.
 *
 * @param moduleDirectory - The app's Python module directory (import root).
 * @returns The `function_app.py` contents.
 * @throws Never - pure string build.
 * @typeParam None - this function has no generic type parameters.
 */
export function pythonFunctionAppMain (moduleDirectory: string): string {
  return `import azure.functions as func

from ${moduleDirectory}.greeting import build_greeting

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)


@app.route(route="hello")
def hello(req: func.HttpRequest) -> func.HttpResponse:
    name = req.params.get("name", "world")
    return func.HttpResponse(build_greeting(name))
`
}

/**
 * The `host.json` written into a generated Python function app.
 *
 * @remarks
 * The v4 extension bundle is what the Functions host uses to resolve bindings;
 * `version: 2.0` is the runtime schema. Deliberately minimal.
 */
export const PYTHON_FUNCTION_APP_HOST_JSON = `{
  "version": "2.0",
  "extensionBundle": {
    "id": "Microsoft.Azure.Functions.ExtensionBundle",
    "version": "[4.*, 5.0.0)"
  }
}
`

/**
 * The `requirements.txt` written into a generated Python function app.
 *
 * @remarks
 * Azure's Python worker installs these at deploy time (Oryx build). Only the
 * SDK is needed for the sample; app deps are added here as the app grows.
 */
export const PYTHON_FUNCTION_APP_REQUIREMENTS = `azure-functions
`

/**
 * A sample pure helper written into a Python function app's module.
 *
 * @remarks
 * Gives the app a genuinely testable unit (the HTTP handler would need the
 * Functions runtime), so pytest has a real passing test out of the box.
 */
export const PYTHON_FUNCTION_APP_GREETING = `def build_greeting(name: str) -> str:
    """Build the greeting returned by the sample HTTP function."""
    return "Hello, " + name + "!"
`

/**
 * The sample pytest proving the Python function app's test target runs.
 *
 * @remarks
 * Imports only the pure helper (no `azure-functions`), so it passes on a bare
 * workspace under `uv run pytest`.
 *
 * @param moduleDirectory - The app's Python module directory (import root).
 * @returns The `tests/test_greeting.py` contents.
 * @throws Never - pure string build.
 * @typeParam None - this function has no generic type parameters.
 */
export function pythonFunctionAppGreetingTest (moduleDirectory: string): string {
  return `from ${moduleDirectory}.greeting import build_greeting


def test_build_greeting() -> None:
    assert build_greeting("world") == "Hello, world!"
`
}
