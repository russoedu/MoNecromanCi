import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runNx, runShell } from '../../nx'
import { promptText } from '../../prompts'
import { fileExists, readJson, toJson, writeFileEnsured } from '../../util/fsx'
import { logger } from '../../util/logger'
import { ensureAdmZip, hasPlugin, registerProjectCommands, type AddOptions } from './shared'

/**
 * Fails fast, with an install hint, when Python is not on the PATH.
 *
 * @param workspaceRoot - Absolute path to the workspace (cwd for the probe).
 * @returns Nothing.
 * @throws Error when neither `python3` nor `python` can be run.
 * @typeParam None - this function has no generic type parameters.
 */
function ensurePython(workspaceRoot: string): void {
  const hasPython =
    runShell('python3', ['--version'], workspaceRoot) === 0 ||
    runShell('python', ['--version'], workspaceRoot) === 0
  if (!hasPython) {
    throw new Error(
      'Python not found. Install Python 3.9+ first: https://www.python.org/downloads/'
    )
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
function pythonPipPluginSpec(): string {
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
function ensurePythonPipPlugin(workspaceRoot: string): void {
  if (hasPlugin(workspaceRoot, '@mnci/nx-python-pip')) {
    return
  }
  const spec = pythonPipPluginSpec()
  logger.step(`Installing the Python toolchain plugin (${spec})`)
  if (
    runShell('npm', ['install', '--save-dev', spec, '--no-audit', '--no-fund'], workspaceRoot) !== 0
  ) {
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
 * executors shell out to; `pip-audit` is the PyPA vulnerability scanner the
 * generated CI's audit step (`overlay.ts`'s `PIP_AUDIT_GUARD`) runs against
 * the shared environment. No lock file — plain pip has none, matching the
 * company's standard toolchain (no uv, no Poetry). mnci writes this file
 * (not the plugin): the plugin is a generic Nx plugin with no opinion on how
 * its own runtime dependencies get onto a machine.
 */
export const PYTHON_REQUIREMENTS_DEV = `build
twine
ruff
pytest
pip-audit
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
function ensureRequirementsDev(workspaceRoot: string): void {
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
function pythonModuleDirectory(name: string): string {
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
function addProjectJsonTargets(projectJsonPath: string, newTargets: Record<string, unknown>): void {
  const project = readJson<Record<string, unknown>>(projectJsonPath)
  const targets = (project.targets as Record<string, unknown> | undefined) ?? {}
  writeFileEnsured(projectJsonPath, toJson({ ...project, targets: { ...targets, ...newTargets } }))
}

/**
 * The runnable entry point written into every generated Python app.
 *
 * @remarks
 * `@mnci/nx-python-pip:application` scaffolds a module (`<name>/__init__.py`)
 * shaped like a library — no `if __name__ == '__main__':` block, since the
 * plugin has no opinion on what "running" an app means. This file is what
 * gives `mnci add python-app` a real local-dev entry point for
 * {@link pythonAppStartTarget} to run, independent of whatever the sample
 * module's own function happens to be named — so it survives that code being
 * deleted or rewritten.
 *
 * @param name - The project name (used only in the printed message).
 * @returns The `main.py` file contents.
 * @throws Never - pure string formatting.
 * @typeParam None - this function has no generic type parameters.
 */
export function pythonAppMain(name: string): string {
  return `def main() -> None:
    print('${name} is running')


if __name__ == '__main__':
    main()
`
}

/**
 * The `start` target for a Python app: `python3 main.py`, locally.
 *
 * @remarks
 * `continuous: true` marks it as a long-running dev task, matching the shape
 * every other kind's custom `start` target uses — Nx does not try to cache or
 * wait out a process that never exits on its own (a Python "app" here is
 * whatever `main.py` does; many will exit immediately, but the target shape
 * stays uniform rather than guessing).
 *
 * @param name - The Python app's project name.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function pythonAppStartTarget(name: string): Record<string, unknown> {
  return {
    executor: 'nx:run-commands',
    continuous: true,
    options: { command: 'python3 main.py', cwd: `apps/${name}` }
  }
}

/**
 * The `start` target for a Python Azure Function: `func start`, locally.
 *
 * @remarks
 * Unlike the Node function app, this needs no prior `build` — Python function
 * apps deploy as source ({@link pythonFunctionAppPackageTarget}), so
 * `function_app.py` + `host.json` already sit together in the project root
 * exactly as Core Tools expects. Requires Azure Functions Core Tools (and the
 * Python worker) locally — never a prerequisite for
 * `add python-function-app` itself.
 *
 * @param name - The function app's project name.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function pythonFunctionAppStartTarget(name: string): Record<string, unknown> {
  return {
    executor: 'nx:run-commands',
    continuous: true,
    options: { command: 'func start', cwd: `apps/${name}` }
  }
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
function pythonAppPackageTarget(name: string): Record<string, unknown> {
  const zip = `dist/drop/python-app-${name}.zip`
  const command = `node -e "const fs=require('node:fs');fs.mkdirSync('dist/drop',{recursive:true});const A=require('adm-zip');const z=new A();z.addLocalFolder('apps/${name}/dist');z.writeZip('${zip}')"`
  return {
    executor: 'nx:run-commands',
    dependsOn: ['build'],
    outputs: [`{workspaceRoot}/${zip}`],
    options: { command }
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
function pythonFunctionAppPackageTarget(
  name: string,
  moduleDirectory: string
): Record<string, unknown> {
  const zip = `dist/drop/python-function-app-${name}.zip`
  const root = `apps/${name}`
  const command = `node -e "const fs=require('node:fs');fs.mkdirSync('dist/drop',{recursive:true});const A=require('adm-zip');const z=new A();z.addLocalFile('${root}/function_app.py');z.addLocalFile('${root}/host.json');z.addLocalFile('${root}/requirements.txt');z.addLocalFolder('${root}/${moduleDirectory}','${moduleDirectory}');z.writeZip('${zip}')"`
  return {
    executor: 'nx:run-commands',
    outputs: [`{workspaceRoot}/${zip}`],
    options: { command }
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
export function addPythonApp(workspaceRoot: string, name: string): void {
  ensurePython(workspaceRoot)
  ensurePythonPipPlugin(workspaceRoot)
  ensureRequirementsDev(workspaceRoot)
  ensureAdmZip(workspaceRoot)

  runNx(
    ['g', '@mnci/nx-python-pip:application', name, `--directory=apps/${name}`, '--no-interactive'],
    workspaceRoot
  )
  writeFileEnsured(join(workspaceRoot, 'apps', name, 'main.py'), pythonAppMain(name))
  addProjectJsonTargets(join(workspaceRoot, 'apps', name, 'project.json'), {
    package: pythonAppPackageTarget(name),
    start: pythonAppStartTarget(name)
  })
  registerProjectCommands(workspaceRoot, name, { build: true, start: `nx run ${name}:start` })
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
export function addPythonFunctionApp(workspaceRoot: string, name: string): void {
  ensurePython(workspaceRoot)
  ensurePythonPipPlugin(workspaceRoot)
  ensureRequirementsDev(workspaceRoot)
  ensureAdmZip(workspaceRoot)

  runNx(
    [
      'g',
      '@mnci/nx-python-pip:function-application',
      name,
      `--directory=apps/${name}`,
      '--no-interactive'
    ],
    workspaceRoot
  )
  const moduleDirectory = pythonModuleDirectory(name)
  addProjectJsonTargets(join(workspaceRoot, 'apps', name, 'project.json'), {
    package: pythonFunctionAppPackageTarget(name, moduleDirectory),
    start: pythonFunctionAppStartTarget(name)
  })
  registerProjectCommands(workspaceRoot, name, { build: false, start: `nx run ${name}:start` })
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
export function addPythonLib(workspaceRoot: string, name: string): void {
  ensurePython(workspaceRoot)
  ensurePythonPipPlugin(workspaceRoot)
  ensureRequirementsDev(workspaceRoot)

  runNx(
    [
      'g',
      '@mnci/nx-python-pip:library',
      name,
      `--directory=python-packages/${name}`,
      '--no-interactive'
    ],
    workspaceRoot
  )
  registerProjectCommands(workspaceRoot, name, { build: true })
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
export function addPythonInternalLib(workspaceRoot: string, name: string): void {
  ensurePython(workspaceRoot)
  ensurePythonPipPlugin(workspaceRoot)
  ensureRequirementsDev(workspaceRoot)

  runNx(
    [
      'g',
      '@mnci/nx-python-pip:internal-library',
      name,
      `--directory=libs/${name}`,
      '--no-interactive'
    ],
    workspaceRoot
  )
  registerProjectCommands(workspaceRoot, name, { build: false })
}

/**
 * The directories a Python project (app, publishable lib, internal lib) can
 * live under — mirrors the directory convention every Python `add*` function
 * above already writes to.
 */
const PYTHON_PROJECT_DIRS = ['apps', 'python-packages', 'libs'] as const

/**
 * Finds which of the three Python project directories holds `name`'s
 * `pyproject.toml`.
 *
 * @remarks
 * A Python function app has no `pyproject.toml` at all (source deploy, no
 * wheel — see {@link addPythonFunctionApp}), so it is never found here; that
 * is intentional, not a gap — there is nothing to vendor into.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name to look up.
 * @returns The directory (`apps`, `python-packages`, or `libs`) the project
 * lives under, or `undefined` when no matching `pyproject.toml` exists.
 * @throws Never - pure filesystem probing.
 * @typeParam None - this function has no generic type parameters.
 */
function findPythonProjectDirectory(
  workspaceRoot: string,
  name: string
): (typeof PYTHON_PROJECT_DIRS)[number] | undefined {
  return PYTHON_PROJECT_DIRS.find(directory =>
    fileExists(join(workspaceRoot, directory, name, 'pyproject.toml'))
  )
}

/**
 * Extracts the vendored internal-lib project names from a `pyproject.toml`'s
 * `[tool.mnci-python-pip] vendor = [...]` table.
 *
 * @remarks
 * Mirrors `@mnci/nx-python-pip`'s own `parseVendorEntries` (`internal/vendor.ts`,
 * not part of that package's public API) — kept as a small, independent
 * regex here rather than adding a runtime dependency on that package for one
 * function: this CLI already owns the exact shape it writes (via
 * {@link addPythonVendor}), the same reasoning that justifies the plugin's
 * own copy owning the shape it reads.
 *
 * @param pyprojectToml - The `pyproject.toml` file contents.
 * @returns The vendored project names, or `[]` when the project vendors nothing.
 * @throws Never - a missing/malformed table simply yields an empty array.
 * @typeParam None - this function has no generic type parameters.
 */
function parseVendorEntries(pyprojectToml: string): string[] {
  const match = /^\s*vendor\s*=\s*\[([^\]]*)\]/m.exec(pyprojectToml)
  if (!match) {
    return []
  }
  return match[1]
    .split(',')
    .map(entry => entry.trim().replaceAll(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/**
 * Adds `lib` to a `pyproject.toml`'s `[tool.mnci-python-pip] vendor = [...]`
 * table, creating the table when absent.
 *
 * @remarks
 * Every Python project's `pyproject.toml` this CLI generates (via
 * `@mnci/nx-python-pip`'s `pythonPyprojectToml`) ends with a fixed
 * `[tool.pytest.ini_options]` table — a reliable, always-present anchor to
 * insert the new table right before, matching the exact shape a hand-edit
 * would produce (see `@mnci/nx-python-pip`'s README). Caller ensures `lib`
 * is not already present ({@link parseVendorEntries}) before calling this.
 *
 * @param pyprojectToml - The consumer's current `pyproject.toml` contents.
 * @param lib - The internal-lib project name to add.
 * @returns The patched `pyproject.toml` contents.
 * @throws Never - pure string manipulation; an existing table without the
 * `[tool.pytest.ini_options]` anchor is left with a new table appended at
 * the end instead.
 * @typeParam None - this function has no generic type parameters.
 */
function addVendorEntry(pyprojectToml: string, lib: string): string {
  const existing = parseVendorEntries(pyprojectToml)
  if (existing.length > 0) {
    const merged = [...existing, lib].map(name => `"${name}"`).join(', ')
    return pyprojectToml.replace(
      /^(\s*vendor\s*=\s*)\[[^\]]*\]/m,
      (_match, prefix: string) => `${prefix}[${merged}]`
    )
  }
  const table = `[tool.mnci-python-pip]\nvendor = ["${lib}"]\n\n`
  return pyprojectToml.includes('[tool.pytest.ini_options]')
    ? pyprojectToml.replace('[tool.pytest.ini_options]', () => `${table}[tool.pytest.ini_options]`)
    : `${pyprojectToml}\n${table}`
}

/**
 * Wires an internal Python library into a consumer's built wheel, by
 * hand-adding a `[tool.mnci-python-pip] vendor = [...]` entry to the
 * consumer's `pyproject.toml`.
 *
 * @remarks
 * Automates the one step `@mnci/nx-python-pip`'s README documents as always
 * hand-added (plain pip has no bundled-local-dependency feature — see that
 * package's "Internal-lib vendoring" section): this function does the exact
 * same text edit a developer would make by hand, just validated and
 * idempotent. Nothing is regenerated or reinstalled — the vendored module is
 * only copied into the consumer's wheel at the consumer's next `build` (the
 * plugin's `build` executor resolves `lib`'s root via the real Nx project
 * graph at that point, not anything this function writes).
 *
 * `lib` is resolved the same way `addNpmLib` resolves `--scope`: taken from
 * `options.lib` when given, prompted for on the bare/interactive path
 * (`kindProvided` false), and a clear error otherwise — there is no sensible
 * default library to fall back to silently.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param consumer - The project name to vendor into (an app, publishable lib,
 * or another internal lib — anything with a `pyproject.toml`).
 * @param options - The CLI flags (`--lib`).
 * @param kindProvided - Whether `python-vendor` was passed explicitly (flag
 * path) rather than picked interactively — gates the `--lib` prompt.
 * @returns A promise that resolves once the edit is written.
 * @throws Error when no library was given/prompted, `consumer` has no
 * `pyproject.toml`, the library is not an internal library under `libs/`, or
 * a project is asked to vendor itself.
 * @typeParam None - this function has no generic type parameters.
 */
export async function addPythonVendor(
  workspaceRoot: string,
  consumer: string,
  options: AddOptions,
  kindProvided: boolean
): Promise<void> {
  const lib =
    options.lib ??
    (kindProvided
      ? undefined
      : await promptText('Internal Python library to vendor (an existing libs/<name>)'))
  if (!lib) {
    throw new Error(
      '`add python-vendor` needs the library to vendor: pass --lib <name> (an existing libs/<name> internal library).'
    )
  }

  const consumerDirectory = findPythonProjectDirectory(workspaceRoot, consumer)
  if (!consumerDirectory) {
    throw new Error(
      `No Python project named '${consumer}' with a pyproject.toml found (checked apps/, python-packages/, libs/). A Python function app has no pyproject.toml — there is nothing to vendor into.`
    )
  }
  if (!fileExists(join(workspaceRoot, 'libs', lib, 'pyproject.toml'))) {
    throw new Error(
      `No internal Python library named '${lib}' found at libs/${lib}/pyproject.toml. Only an internal library (added via 'mnci add python-internal-lib') can be vendored.`
    )
  }
  if (consumerDirectory === 'libs' && consumer === lib) {
    throw new Error(`'${consumer}' cannot vendor itself.`)
  }

  const pyprojectPath = join(workspaceRoot, consumerDirectory, consumer, 'pyproject.toml')
  const pyprojectToml = readFileSync(pyprojectPath, 'utf8')
  if (parseVendorEntries(pyprojectToml).includes(lib)) {
    logger.info(`'${consumer}' already vendors '${lib}' — nothing to do.`)
    return
  }

  writeFileEnsured(pyprojectPath, addVendorEntry(pyprojectToml, lib))
  logger.success(
    `'${consumer}' now vendors '${lib}' — its wheel will include '${lib}''s module on the next build.`
  )
}
