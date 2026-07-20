import { join } from 'node:path'
import { runNx, runShell } from '../../nx'
import { readJson, toJson, writeFileEnsured } from '../../util/fsx'
import { logger } from '../../util/logger'
import { ensureAdmZip, hasPlugin } from './shared'

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
 * Python projects (unlike the inference-only TS apps that attach targets via
 * the manifest `nx` field) carry a real `project.json`, so packaging/publish
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
 * Redirects a Python project's `build` target output to the workspace-root `dist/`.
 *
 * @remarks
 * `@nxlv/python:uv-project` always writes a `build` target with
 * `outputPath: '{projectRoot}/dist'` — unlike the TS/JS kinds, this is a
 * plain `project.json` option (no generator-native config file to edit), and
 * `uv build` stages the package from a temporary copy before writing the
 * wheel to `outputPath`, so redirecting it outside the project directory is
 * safe (verified empirically: the wheel's contents are unaffected by where
 * the artifact file ends up — unlike npm-lib/internal-lib, Python's
 * packaging has no directory-boundary restriction). `{workspaceRoot}` is an
 * Nx-recognized token, resolved the same way in `outputs` and `options`.
 *
 * @param projectJsonPath - Absolute path to the project's `project.json`.
 * @param outputPath - The workspace-relative dist path (e.g. `dist/apps/svc`).
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the file.
 * @typeParam None - this function has no generic type parameters.
 */
function redirectBuildOutput (projectJsonPath: string, outputPath: string): void {
  const project = readJson<Record<string, unknown>>(projectJsonPath)
  const targets = (project.targets as Record<string, Record<string, unknown>> | undefined) ?? {}
  const build = (targets.build as Record<string, unknown> | undefined) ?? {}
  const options = (build.options as Record<string, unknown> | undefined) ?? {}
  writeFileEnsured(projectJsonPath, toJson({
    ...project,
    targets: {
      ...targets,
      build: {
        ...build,
        // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- {workspaceRoot} is an Nx output token
        outputs: [`{workspaceRoot}/${outputPath}`],
        options: {
          ...options,
          // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- {workspaceRoot} is an Nx output token
          outputPath: `{workspaceRoot}/${outputPath}`,
        },
      },
    },
  }))
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
 * Zips `dist/apps/<name>` (the `@nxlv/python:build` wheel + sdist, redirected
 * there by {@link redirectBuildOutput}) into `dist/drop/python-app-<name>.zip`
 * — basename exactly `python-app-<name>`, the string CI turns into the
 * per-app build tag. `dependsOn: build` guarantees the wheel exists; same
 * cross-platform `adm-zip` one-liner used throughout `add`.
 *
 * @param name - The Python app's project name.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function pythonAppPackageTarget (name: string): Record<string, unknown> {
  const zip = `dist/drop/python-app-${name}.zip`
  const command = `node -e "const fs=require('node:fs');fs.mkdirSync('dist/drop',{recursive:true});const A=require('adm-zip');const z=new A();z.addLocalFolder('dist/apps/${name}');z.writeZip('${zip}')"`
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

/**
 * Adds a Python app: `@nxlv/python:uv-project` plus a wheel-packaging target.
 *
 * @remarks
 * Python apps carry a real `project.json` (unlike the inference-only TS apps),
 * so the packaging target goes straight in it. The build target emits a wheel
 * to `apps/<name>/dist`; {@link pythonAppPackageTarget} zips that into the
 * drop under the exact name CI turns into a build tag.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Python/uv is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addPythonApp (workspaceRoot: string, name: string): void {
  preparePython(workspaceRoot)
  runUvProject(workspaceRoot, { name, directory: `apps/${name}`, projectType: 'application' })
  const projectJsonPath = join(workspaceRoot, 'apps', name, 'project.json')
  redirectBuildOutput(projectJsonPath, `dist/apps/${name}`)
  ensureAdmZip(workspaceRoot)
  addProjectJsonTargets(projectJsonPath, { package: pythonAppPackageTarget(name) })
}

/**
 * Adds a Python Azure Function: `@nxlv/python:uv-project` plus the Azure Functions v2 shape.
 *
 * @remarks
 * The plugin scaffolds a plain package; overlay the Azure Functions v2 shape
 * (`function_app.py` + `host.json` + `requirements.txt`) and a pure,
 * pytest-covered helper in the module. The deployable is the source zip, not
 * the wheel, so `package` zips those files (`func` CLI not needed).
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Python/uv is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addPythonFunctionApp (workspaceRoot: string, name: string): void {
  preparePython(workspaceRoot)
  runUvProject(workspaceRoot, { name, directory: `apps/${name}`, projectType: 'application' })
  const pythonFunctionAppRoot = join(workspaceRoot, 'apps', name)
  redirectBuildOutput(join(pythonFunctionAppRoot, 'project.json'), `dist/apps/${name}`)
  const moduleDirectory = pythonModuleDirectory(join(pythonFunctionAppRoot, 'project.json'), name)
  writeFileEnsured(join(pythonFunctionAppRoot, 'function_app.py'), pythonFunctionAppMain(moduleDirectory))
  writeFileEnsured(join(pythonFunctionAppRoot, 'host.json'), PYTHON_FUNCTION_APP_HOST_JSON)
  writeFileEnsured(join(pythonFunctionAppRoot, 'requirements.txt'), PYTHON_FUNCTION_APP_REQUIREMENTS)
  writeFileEnsured(join(pythonFunctionAppRoot, moduleDirectory, 'greeting.py'), PYTHON_FUNCTION_APP_GREETING)
  writeFileEnsured(join(pythonFunctionAppRoot, 'tests', 'test_greeting.py'), pythonFunctionAppGreetingTest(moduleDirectory))
  ensureAdmZip(workspaceRoot)
  addProjectJsonTargets(join(pythonFunctionAppRoot, 'project.json'), { package: pythonFunctionAppPackageTarget(name, moduleDirectory) })
}

/**
 * Adds a publishable Python library under `python-packages/`.
 *
 * @remarks
 * `--publishable` makes the plugin stamp the project's `nx-release-publish`
 * hook (uv publish) AND its `release.version.versionActions` (conventional-
 * commit versioning of `pyproject.toml`), so the shared `nx release` (scoped
 * to `python-packages/*`) versions, tags and publishes it — no extra target.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Python/uv is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addPythonLib (workspaceRoot: string, name: string): void {
  preparePython(workspaceRoot)
  runUvProject(workspaceRoot, { name, directory: `python-packages/${name}`, projectType: 'library', publishable: true })
  redirectBuildOutput(join(workspaceRoot, 'python-packages', name, 'project.json'), `dist/python-packages/${name}`)
}

/**
 * Adds a private Python library under `libs/`.
 *
 * @remarks
 * Not publishable (no `--publishable` → no release hook), so it is
 * structurally never released; the plugin bundles it into consumers' wheels
 * (`bundleLocalDependencies`) the way an internal-lib is compiled in.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Python/uv is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addPythonInternalLib (workspaceRoot: string, name: string): void {
  preparePython(workspaceRoot)
  runUvProject(workspaceRoot, { name, directory: `libs/${name}`, projectType: 'library' })
  redirectBuildOutput(join(workspaceRoot, 'libs', name, 'project.json'), `dist/libs/${name}`)
}
