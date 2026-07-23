import { join } from 'node:path'
import { runNx, runShell } from '../../nx'
import { fileExists, readJson, toJson, writeFileEnsured } from '../../util/fsx'
import { logger } from '../../util/logger'
import { ensureAdmZip, hasPlugin } from './shared'

/**
 * Fails fast, with an install hint, when Python is not on the PATH.
 *
 * @param workspaceRoot - Absolute path to the workspace (cwd for the probe).
 * @returns Nothing.
 * @throws Error when neither `python3` nor `python` can be run.
 * @typeParam None - this function has no generic type parameters.
 */
function ensurePython (workspaceRoot: string): void {
  const hasPython = runShell('python3', ['--version'], workspaceRoot) === 0 || runShell('python', ['--version'], workspaceRoot) === 0
  if (!hasPython) {
    throw new Error('Python not found. Install Python 3.9+ first: https://www.python.org/downloads/')
  }
}

/**
 * The `@mnci/nx-python-pip` package spec to install.
 *
 * @remarks
 * Reads `MNCI2_PYTHON_PIP_SPEC` so the e2e suite can point this at a local
 * tarball (`npm pack`'d from `libs/nx-python-pip` in this same monorepo)
 * instead of the published registry package — the real published spec is
 * the default for every real `mnci add python-*` call.
 */
function pythonPipPluginSpec (): string {
  return process.env.MNCI2_PYTHON_PIP_SPEC ?? '@mnci/nx-python-pip'
}

/**
 * Ensures the `@mnci/nx-python-pip` Nx plugin is installed.
 *
 * @remarks
 * Unlike `@nxlv/python`, this plugin needs no `nx.json` `plugins`
 * registration: its generators/executors are explicit, resolved by plain
 * Node module lookup against its `generators.json`/`executors.json` —
 * registration in `plugins` is only for inference plugins that scan the
 * filesystem, which this is not. A plain `npm install` is the whole story.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Error when the install exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function ensurePythonPipPlugin (workspaceRoot: string): void {
  if (hasPlugin(workspaceRoot, '@mnci/nx-python-pip')) {
    return
  }
  const spec = pythonPipPluginSpec()
  logger.step(`Installing the Python toolchain plugin (${spec})`)
  if (runShell('npm', ['install', '--save-dev', spec, '--no-audit', '--no-fund'], workspaceRoot) !== 0) {
    throw new Error('npm install of @mnci/nx-python-pip failed')
  }
}

/**
 * The fixed toolchain every Python project shares, written once to the
 * workspace root as `requirements-dev.txt`.
 *
 * @remarks
 * Ruff and pytest are the industry standard; `build` and `twine` are the
 * standard PyPA build/publish frontends that `@mnci/nx-python-pip`'s
 * executors shell out to. No lock file — plain pip has none, matching the
 * company's standard toolchain (no uv, no Poetry). mnci writes this file
 * (not the plugin): the plugin is a generic Nx plugin with no opinion on how
 * its own runtime dependencies get onto a machine.
 */
export const PYTHON_REQUIREMENTS_DEV = `build
twine
ruff
pytest
`

/**
 * Idempotently writes `requirements-dev.txt` to the workspace root.
 *
 * @remarks
 * Lazy, like {@link ensureAdmZip}: written on the first Python `add` of any
 * kind, not unconditionally by `mnci new` — a pure-JS/TS workspace never
 * gains this file. Only written when absent, so a user's own edits (extra
 * dev tools) survive repeat `add` calls.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error raised while writing.
 * @typeParam None - this function has no generic type parameters.
 */
function ensureRequirementsDev (workspaceRoot: string): void {
  const requirementsDevPath = join(workspaceRoot, 'requirements-dev.txt')
  if (!fileExists(requirementsDevPath)) {
    writeFileEnsured(requirementsDevPath, PYTHON_REQUIREMENTS_DEV)
  }
}

/**
 * A Python project's module directory name, derived from its Nx project name.
 *
 * @remarks
 * Mirrors `@mnci/nx-python-pip`'s own derivation (Python identifiers cannot
 * contain hyphens) — needed here only to name the module folder inside the
 * function app's source zip.
 *
 * @param name - The project name.
 * @returns The module directory's basename (e.g. `my_svc`).
 * @throws Never - pure string mapping.
 * @typeParam None - this function has no generic type parameters.
 */
function pythonModuleDirectory (name: string): string {
  return name.replaceAll('-', '_')
}

/**
 * Merges extra targets into a plugin-written `project.json`.
 *
 * @remarks
 * `@mnci/nx-python-pip`'s generators write a real `project.json` (not an
 * inference-only manifest), so the `package` (zip) target — mnci's own CI
 * convention, not a generic plugin concern — is merged straight into it
 * after generation.
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
 * The `package` target for a Python app: zip its built wheel into the drop.
 *
 * @remarks
 * Zips `apps/<name>/dist` (the plugin's `build` executor's wheel + sdist)
 * into `dist/drop/python-app-<name>.zip` — basename exactly
 * `python-app-<name>`, the string CI turns into the per-app build tag.
 * `dependsOn: build` guarantees the wheel exists; same cross-platform
 * `adm-zip` one-liner used throughout `add`.
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
 * `requirements.txt` and runs `function_app.py`), not as a wheel — so this
 * zips `function_app.py` + `host.json` + `requirements.txt` + the module
 * package (all written by the plugin's `function-application` generator)
 * into `dist/drop/python-function-app-<name>.zip`. Basename exactly
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
 * Adds a Python app: `@mnci/nx-python-pip:application` plus mnci's own zip packaging.
 *
 * @remarks
 * Pure delegation to the plugin generator, same shape as every other kind
 * (`react-app`, `node-app`, `npm-lib`) — the plugin owns `pyproject.toml` +
 * `project.json` (lint/test/build); mnci only layers its own CI packaging
 * convention on top, via {@link pythonAppPackageTarget}.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Python is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addPythonApp (workspaceRoot: string, name: string): void {
  ensurePython(workspaceRoot)
  ensurePythonPipPlugin(workspaceRoot)
  ensureRequirementsDev(workspaceRoot)
  ensureAdmZip(workspaceRoot)

  runNx(['g', '@mnci/nx-python-pip:application', name, `--directory=apps/${name}`, '--no-interactive'], workspaceRoot)
  addProjectJsonTargets(join(workspaceRoot, 'apps', name, 'project.json'), { package: pythonAppPackageTarget(name) })
}

/**
 * Adds a Python Azure Function: `@mnci/nx-python-pip:function-application` plus mnci's own zip packaging.
 *
 * @remarks
 * The plugin generator writes the Azure Functions v2 shape (`function_app.py`
 * + `host.json` + `requirements.txt` + a tested pure helper); mnci only adds
 * the `package` target zipping that source into the drop.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Python is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addPythonFunctionApp (workspaceRoot: string, name: string): void {
  ensurePython(workspaceRoot)
  ensurePythonPipPlugin(workspaceRoot)
  ensureRequirementsDev(workspaceRoot)
  ensureAdmZip(workspaceRoot)

  runNx(['g', '@mnci/nx-python-pip:function-application', name, `--directory=apps/${name}`, '--no-interactive'], workspaceRoot)
  const moduleDirectory = pythonModuleDirectory(name)
  addProjectJsonTargets(join(workspaceRoot, 'apps', name, 'project.json'), { package: pythonFunctionAppPackageTarget(name, moduleDirectory) })
}

/**
 * Adds a publishable Python library under `python-packages/`.
 *
 * @remarks
 * `@mnci/nx-python-pip:library` wires the whole publishable shape itself —
 * `nx-release-publish` (twine) and the project-level
 * `release.version.versionActions` override — so no post-generation merge is
 * needed here at all, unlike the app kinds.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Python is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addPythonLib (workspaceRoot: string, name: string): void {
  ensurePython(workspaceRoot)
  ensurePythonPipPlugin(workspaceRoot)
  ensureRequirementsDev(workspaceRoot)

  runNx(['g', '@mnci/nx-python-pip:library', name, `--directory=python-packages/${name}`, '--no-interactive'], workspaceRoot)
}

/**
 * Adds a private Python library under `libs/`.
 *
 * @remarks
 * Not publishable — `@mnci/nx-python-pip:internal-library` writes lint/test
 * targets only, no build/publish. Consumers vendor its module directly into
 * their own wheel at build time by hand-adding a `vendor` entry (under
 * `[tool.mnci-python-pip]`) to their own `pyproject.toml`.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Python is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addPythonInternalLib (workspaceRoot: string, name: string): void {
  ensurePython(workspaceRoot)
  ensurePythonPipPlugin(workspaceRoot)
  ensureRequirementsDev(workspaceRoot)

  runNx(['g', '@mnci/nx-python-pip:internal-library', name, `--directory=libs/${name}`, '--no-interactive'], workspaceRoot)
}
