import { join } from 'node:path'
import { runNx, runShell } from '../../nx'
import { readJson, toJson, writeFileEnsured } from '../../util/fsx'
import { logger } from '../../util/logger'
import { addNxTargets, ensureAdmZip, hasPlugin, type WorkspaceStack } from './shared'

/**
 * Ensures an Nx plugin is installed in the workspace, installing it on first use.
 *
 * @remarks
 * `nx add` installs the package and runs its init generator — the Nx-native
 * way to bring a plugin into an existing workspace. Same pattern as
 * `add/reactApp.ts`'s `ensurePlugin`.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param packageName - The plugin package (e.g. `@nx/node`).
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
 * Generates a Node app with the official `@nx/node:application` generator.
 *
 * @remarks
 * Plain delegation — `esbuild` (non-bundled: it transpiles each file and
 * mirrors the workspace tree into `dist`, rather than producing one bundled
 * file) is the generator's own default, and `--framework=none` keeps the
 * scaffold a bare Node app (no Express/Fastify/Koa/Nest opinion). Both
 * `node-app` and `node-function-app` generate identically — the function app
 * is this plus an Azure Functions v2 file overlay, the same split already
 * used for `python-app`/`python-function-app` (`add/python.ts`).
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @param stack - The workspace's chosen linter/test runner.
 * @returns Nothing.
 * @throws Error when the generator exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function runNodeApp (workspaceRoot: string, name: string, stack: WorkspaceStack): void {
  ensurePlugin(workspaceRoot, '@nx/node')
  runNx([
    'g', '@nx/node:application', `apps/${name}`,
    '--bundler=esbuild',
    `--unitTestRunner=${stack.testRunner}`,
    `--linter=${stack.linter}`,
    '--e2eTestRunner=none',
    '--framework=none',
    '--no-interactive',
  ], workspaceRoot)
}

/**
 * The `package` target for a plain Node app: zip its build output into the drop.
 *
 * @remarks
 * `@nx/esbuild:esbuild --bundle=false` mirrors the full workspace-relative
 * source tree into `apps/<name>/dist` (e.g. `dist/apps/<name>/src/main.js`)
 * plus a `dist/main.js` shim that `require`s it — so zipping the whole `dist`
 * folder is the complete, runnable output. Basename exactly `node-app-<name>`,
 * the string CI turns into the per-app build tag. Same cross-platform
 * `adm-zip` one-liner used throughout `add`.
 *
 * @param name - The Node app's project name.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function nodeAppPackageTarget (name: string): Record<string, unknown> {
  const zip = `dist/drop/node-app-${name}.zip`
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
 * Adds a plain Node app: `@nx/node:application` plus a packaging target.
 *
 * @remarks
 * Pure delegation to the official generator (esbuild, non-bundled) — no
 * custom build rewiring, no relocated output; every kind builds to its own
 * Nx-default location. {@link nodeAppPackageTarget} is the one thing the
 * generator doesn't do: zip the build into the CI drop.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @param stack - The workspace's chosen linter/test runner.
 * @returns Nothing.
 * @throws Error when the generator or a required install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addNodeApp (workspaceRoot: string, name: string, stack: WorkspaceStack): void {
  runNodeApp(workspaceRoot, name, stack)
  ensureAdmZip(workspaceRoot)
  addNxTargets(join(workspaceRoot, 'apps', name, 'package.json'), { package: nodeAppPackageTarget(name) })
}

/**
 * Ensures `@azure/functions` is installed at the workspace root.
 *
 * @remarks
 * Unlike the removed `@nxazure/func` plugin (whose generators pulled this in
 * as a side effect), a plain `@nx/node:application` app has no Azure
 * Functions dependency by default, so `add node-function-app` installs it
 * for real — the version then gets read back and stamped into the app's own
 * manifest (see {@link repairNodeFunctionAppManifest}) for Azure's deploy-time
 * `npm install` (Oryx) to resolve.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Error when the install exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function ensureAzureFunctionsPackage (workspaceRoot: string): void {
  if (hasPlugin(workspaceRoot, '@azure/functions')) {
    return
  }
  logger.step('Installing @azure/functions')
  if (runShell('npm', ['install', '@azure/functions', '--no-audit', '--no-fund'], workspaceRoot) !== 0) {
    throw new Error('npm install of @azure/functions failed')
  }
}

/**
 * The bundle entry point written into every generated Node function app.
 *
 * @remarks
 * `@nx/esbuild:esbuild` only includes what is reachable from `main.ts` — the
 * same convention the removed hand-rolled function app used — so add one
 * import per function file you create under `src/functions/`. The import
 * runs `app.http(...)` (or another trigger registration) as a side effect;
 * nothing needs to be re-exported.
 */
export const NODE_FUNCTION_APP_MAIN = `// esbuild only includes what is reachable from here, so add one import per
// function file you create under src/functions/.
import './functions/hello'
`

/**
 * The `host.json` written into a generated Node function app.
 *
 * @remarks
 * Identical shape to the Python function app's `host.json` (written by
 * `@mnci/nx-python-pip:function-application`, the plugin `add/python.ts`
 * delegates to) — the schema is language-agnostic. The v4 extension bundle
 * is what the Functions host uses to resolve bindings; `version: 2.0` is the
 * runtime schema. Deliberately minimal.
 */
export const NODE_FUNCTION_APP_HOST_JSON = `{
  "version": "2.0",
  "extensionBundle": {
    "id": "Microsoft.Azure.Functions.ExtensionBundle",
    "version": "[4.*, 5.0.0)"
  }
}
`

/**
 * The Azure Functions v4 HTTP trigger written into a generated Node function app.
 *
 * @remarks
 * The Node v4 programming model: `app.http(...)` registers a route at import
 * time. The handler is thin — the testable logic lives in
 * {@link NODE_FUNCTION_APP_GREETING} (imported here) — so the sample spec
 * needs no `@azure/functions` mocking. Anonymous auth keeps the sample
 * runnable locally with `func start`.
 */
export const NODE_FUNCTION_APP_HELLO = `import { app, HttpRequest, HttpResponseInit } from '@azure/functions'
import { buildGreeting } from './greeting'

async function hello (request: HttpRequest): Promise<HttpResponseInit> {
  const name = request.query.get('name') ?? 'world'
  return { body: buildGreeting(name) }
}

app.http('hello', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'hello',
  handler: hello,
})
`

/**
 * A sample pure helper written into every generated Node function app.
 *
 * @remarks
 * Gives the app a genuinely testable unit (the HTTP handler would need
 * `@azure/functions` mocking), so the generator's own jest/vitest wiring has
 * a real passing test out of the box. Delete it once you have your own.
 */
export const NODE_FUNCTION_APP_GREETING = `export function buildGreeting (name: string): string {
  return 'Hello, ' + name + '!'
}
`

/**
 * The sample spec proving the function app's test target runs.
 *
 * @remarks
 * Deliberately dependency-free (no Azure SDK), so it passes on a bare
 * workspace under either jest or vitest — `@nx/node:application` wires the
 * chosen runner natively (unlike the removed hand-rolled function app, which
 * carried no test setup of its own).
 */
export const NODE_FUNCTION_APP_GREETING_SPEC = `import { buildGreeting } from './greeting'

describe('buildGreeting', () => {
  it('greets a name', () => {
    expect(buildGreeting('world')).toBe('Hello, world!')
  })
})
`

/**
 * Repairs a Node function app's manifest for an Azure deploy: `main` + the real dependency.
 *
 * @remarks
 * `@nx/esbuild:esbuild --bundle=false` writes a `dist/main.js` shim that
 * `require`s the compiled entry (verified empirically) — so the deployable
 * manifest's `main` is simply `main.js`, sitting beside that shim once the
 * `package` target zips `dist` + `host.json` + `package.json` together (see
 * {@link nodeFunctionAppPackageTarget}). `@azure/functions` is added for
 * real (not just referenced): Azure's deploy-time Oryx build reads this
 * manifest's `dependencies` and runs `npm install` there — verified
 * empirically that a plain `npm install` in a simulated deploy folder (no
 * bundled `node_modules`) resolves and runs correctly once the dependency is
 * declared, mirroring exactly how `python-function-app` already relies on
 * Azure's Python Oryx build installing `requirements.txt` at deploy time.
 *
 * @param nodeFunctionAppRoot - Absolute path to the function app's directory.
 * @param workspaceRoot - Absolute path to the workspace (to read the
 * installed `@azure/functions` version).
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
function repairNodeFunctionAppManifest (nodeFunctionAppRoot: string, workspaceRoot: string): void {
  const manifestPath = join(nodeFunctionAppRoot, 'package.json')
  const manifest = readJson<Record<string, unknown>>(manifestPath)
  const azureFunctionsVersion = readJson<{ version: string }>(join(workspaceRoot, 'node_modules/@azure/functions/package.json')).version
  const dependencies = (manifest.dependencies as Record<string, string> | undefined) ?? {}
  writeFileEnsured(manifestPath, toJson({
    ...manifest,
    main:         'main.js',
    dependencies: { ...dependencies, '@azure/functions': `^${azureFunctionsVersion}` },
  }))
}

/**
 * The `package` target for a Node Azure Function: zip the deployable folder.
 *
 * @remarks
 * Zips `apps/<name>/dist` (the esbuild output — the `main.js` shim plus the
 * mirrored source tree) together with `host.json` and the repaired
 * `package.json` into `dist/drop/node-function-app-<name>.zip`. No
 * `node_modules` bundled: Azure's Oryx build installs real dependencies from
 * the zipped `package.json` at deploy time (see
 * {@link repairNodeFunctionAppManifest}). Basename exactly
 * `node-function-app-<name>` (the CI build tag).
 *
 * @param name - The function app's project name.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function nodeFunctionAppPackageTarget (name: string): Record<string, unknown> {
  const zip = `dist/drop/node-function-app-${name}.zip`
  const root = `apps/${name}`
  const command = `node -e "const fs=require('node:fs');fs.mkdirSync('dist/drop',{recursive:true});const A=require('adm-zip');const z=new A();z.addLocalFolder('${root}/dist');z.addLocalFile('${root}/host.json');z.addLocalFile('${root}/package.json');z.writeZip('${zip}')"`
  return {
    executor:  'nx:run-commands',
    dependsOn: ['build'],
    // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- {workspaceRoot} is an Nx output token
    outputs:   [`{workspaceRoot}/${zip}`],
    options:   { command },
  }
}

/**
 * Adds a Node Azure Function: `@nx/node:application` plus the Azure Functions v4 shape.
 *
 * @remarks
 * Same generator as `node-app` — the difference is purely the overlay:
 * `@azure/functions` installed for real, an HTTP-trigger sample
 * ({@link NODE_FUNCTION_APP_HELLO}) + a pure, test-covered helper, `host.json`,
 * and the manifest repair the deploy needs. The `func` CLI is never invoked —
 * unlike the removed `@nxazure/func` plugin, nothing here shells out to it,
 * so it isn't a prerequisite for `add node-function-app` (only for local
 * `func start`, same as `python-function-app`).
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @param stack - The workspace's chosen linter/test runner.
 * @returns Nothing.
 * @throws Error when the generator or a required install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addNodeFunctionApp (workspaceRoot: string, name: string, stack: WorkspaceStack): void {
  runNodeApp(workspaceRoot, name, stack)
  ensureAzureFunctionsPackage(workspaceRoot)
  const nodeFunctionAppRoot = join(workspaceRoot, 'apps', name)
  writeFileEnsured(join(nodeFunctionAppRoot, 'src/main.ts'), NODE_FUNCTION_APP_MAIN)
  writeFileEnsured(join(nodeFunctionAppRoot, 'src/functions/hello.ts'), NODE_FUNCTION_APP_HELLO)
  writeFileEnsured(join(nodeFunctionAppRoot, 'src/functions/greeting.ts'), NODE_FUNCTION_APP_GREETING)
  writeFileEnsured(join(nodeFunctionAppRoot, 'src/functions/greeting.spec.ts'), NODE_FUNCTION_APP_GREETING_SPEC)
  writeFileEnsured(join(nodeFunctionAppRoot, 'host.json'), NODE_FUNCTION_APP_HOST_JSON)
  repairNodeFunctionAppManifest(nodeFunctionAppRoot, workspaceRoot)
  ensureAdmZip(workspaceRoot)
  addNxTargets(join(nodeFunctionAppRoot, 'package.json'), { package: nodeFunctionAppPackageTarget(name) })
}
