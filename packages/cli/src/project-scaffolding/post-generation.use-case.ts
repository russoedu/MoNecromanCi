import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runNx, runShell } from '../nx-workspace'
import { dependabotConfig, reactExpressPeerOverride } from '../workspace-overlay'
import { fileExists, readCodeWorkspace, readJson, toJson, writeFileEnsured } from '../file-system'
import { logger } from '../terminal'

/**
 * The HTTP frameworks `@nx/node:application` can scaffold a `node-app` with.
 *
 * @remarks
 * The generator's own `--framework` choices (verified empirically against a
 * real Nx 23.1.0 workspace: `nx g @nx/node:application --help`), passed
 * straight through — `node.ts` adds no framework-specific logic of its own.
 * `none` (the default) is a bare Node app with no HTTP framework opinion.
 * `node-function-app` never accepts this: the Azure Functions v4 programming
 * model (`app.http(...)` registration) runs its own request lifecycle, so a
 * full HTTP server framework doesn't apply there.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type NodeFramework = 'express' | 'fastify' | 'koa' | 'nest' | 'none'

/**
 * Options accepted by `runAdd`.
 *
 * @remarks
 * Mirrors the CLI's flags. Defined here (not in `add.ts`) because every
 * per-kind module (`react-app.ts`, `function-app.ts`, `npm-lib.ts`) needs it;
 * `add.ts` re-exports it so its existing public import path
 * (`import { type AddOptions } from './commands/add'`, used by `cli.ts`)
 * keeps working unchanged.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface AddOptions {
  /** npm scope for a publishable lib's import path (defaults to `@<workspace name>`). */
  scope?:     string
  /** `node-app` only: the HTTP framework `@nx/node:application` scaffolds (defaults to `none`, a bare Node app). */
  framework?: NodeFramework
  /** `python-vendor` only: the internal Python library (under `libs/`) to vendor into `name`. */
  lib?:       string
}

/**
 * The workspace stack, generator-facing shape (what `readWorkspaceStack` in
 * `add.ts` resolves and every plugin-generated kind consumes).
 *
 * @remarks
 * Only testRunner is configurable; linting and formatting are always ESLint.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface WorkspaceStack {
  testRunner: 'jest' | 'vitest'
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
export function hasPlugin (workspaceRoot: string, packageName: string): boolean {
  const manifest = readJson<{
    dependencies?:    Record<string, string>
    devDependencies?: Record<string, string>
  }>(join(workspaceRoot, 'package.json'))
  const installed = { ...manifest.dependencies, ...manifest.devDependencies }

  return Object.hasOwn(installed, packageName)
}

/**
 * Ensures an Nx plugin is installed in the workspace, installing it on first use.
 *
 * @remarks
 * `nx add` installs the package and runs its init generator — the Nx-native way
 * to bring a plugin into an existing workspace. Shared by every kind whose
 * generator lives in a plugin the workspace may not have yet (`react-app`,
 * `react-lib`, `react-internal-lib`).
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param packageName - The plugin package (e.g. `@nx/react`).
 * @returns Nothing.
 * @throws Error when the underlying `nx add` exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
export function ensurePlugin (workspaceRoot: string, packageName: string): void {
  if (hasPlugin(workspaceRoot, packageName)) {
    return
  }
  logger.step(`Installing Nx plugin ${packageName}`)
  runNx(['add', packageName], workspaceRoot)
}

/**
 * Runs an Nx generator, then applies mnci's own post-generation repairs even
 * when the generator's underlying install step failed.
 *
 * @remarks
 * `@nx/js:lib --bundler=rollup`/`@nx/react:library` both fetch and install a
 * plugin package (`@nx/rollup`, `@nx/vitest`, …) as part of the generator run
 * the FIRST time a workspace uses that bundler or test runner, via Nx's own
 * `installPackagesTask`. That install can fail for reasons that have nothing
 * to do with the generator's own correctness — reproduced end to end with a
 * real npm 10.9.7 arborist bug on this exact dependency tree
 * (`Cannot read properties of null (reading 'edgesOut')`, gone on npm 11) —
 * and when it does, `runNx` throws AFTER the generator has already written
 * every scaffold file to disk. Without this wrapper, every caller's own
 * post-generation repairs (`repairPublishableManifest`,
 * `repairDeclarationSpecifiers`, `registerProjectCommands`, …) never run,
 * silently, because the exception unwinds straight out of `addNpmLib`/
 * `addReactLib` — leaving a project with the broken `types` path and the
 * unrepaired source-map/declaration-extension defects those repairs exist to
 * fix, and `mnci doctor` had nothing that could point at it: the target
 * files exist, they are just wrong. Reproduced and fixed together.
 *
 * The distinguishing signal is `markerPath`: a file the generator itself
 * writes (its manifest) as one of its very first acts, well before the
 * install step runs. If it is missing, the generator failed before writing
 * anything repairable, and this rethrows the original error unchanged rather
 * than running repairs against a directory that does not exist. If it is
 * present, the scaffold is real regardless of whether install succeeded, so
 * `repair` runs unconditionally — and if install did fail, the original
 * error is rethrown afterwards, with a clearer, actionable message, so the
 * command still exits non-zero rather than reporting a false success.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param nxArguments - The Nx CLI arguments, exactly as `runNx` would take them.
 * @param markerPath - Absolute path to a file the generator writes early,
 * used to tell "failed before writing anything" apart from "failed after".
 * @param repair - Every post-generation repair this kind normally runs on
 * success; now run whenever the scaffold exists, success or not.
 * @returns Nothing.
 * @throws The original `runNx` error, unchanged, when `markerPath` was never
 * written. A new, clearer error wrapping it, after `repair` has still run,
 * when `markerPath` exists but the generator's install step failed anyway.
 * @typeParam None - this function has no generic type parameters.
 */
export function runGeneratorAndRepair (
  workspaceRoot: string,
  nxArguments: string[],
  markerPath: string,
  repair: () => void,
): void {
  let installFailure: Error | undefined
  try {
    runNx(nxArguments, workspaceRoot)
  } catch (error) {
    installFailure = error instanceof Error ? error : new Error(String(error))
  }

  if (!fileExists(markerPath)) {
    throw installFailure ?? new Error(`unreachable: runNx did not throw and ${markerPath} is missing`)
  }

  repair()

  if (installFailure) {
    throw new Error(
      'The project was generated and mnci\'s own repairs were applied, but the ' +
        `underlying Nx generator's install step still failed (${installFailure.message}). ` +
        "Fix the install error above (commonly resolved by 'npm install' with a newer " +
        "npm major), then verify with 'mnci doctor'.",
    )
  }
}

/**
 * Sets `"private": true` in a package manifest.
 *
 * @remarks
 * One of the deliberate post-generation touches: it makes an internal library
 * structurally unpublishable, no matter what future config drifts. Shared by
 * every private-lib kind (`internal-lib`, `react-internal-lib`).
 *
 * @param manifestPath - Absolute path to the lib's `package.json`.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
export function markPrivate (manifestPath: string): void {
  const manifest = readJson<Record<string, unknown>>(manifestPath)
  writeFileEnsured(manifestPath, toJson({ ...manifest, private: true }))
}

/**
 * Sets `publishConfig.access: "public"` in a package manifest.
 *
 * @remarks
 * npm treats every scoped package (`@scope/name` — what every publishable lib's
 * `importPath` always is) as private by default: an unmodified first publish
 * fails with `402 Payment Required — You must sign up for private packages`
 * (verified empirically against the real registry), not with anything a dry-run
 * surfaces, since dry-runs never call the registry. This is the one
 * post-generation touch that makes a freshly added publishable lib publishable
 * as-is. Shared by `npm-lib` and `react-lib`.
 *
 * @param manifestPath - Absolute path to the lib's `package.json`.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
export function markPublic (manifestPath: string): void {
  const manifest = readJson<Record<string, unknown>>(manifestPath)
  writeFileEnsured(manifestPath, toJson({ ...manifest, publishConfig: { access: 'public' } }))
}

/**
 * Replaces the stock README the Nx generators write.
 *
 * @remarks
 * Theirs credits Nx, which did not generate this project - mnci did, delegating one
 * step to an Nx generator. It also names the project by its directory rather than by
 * the package name the workspace actually publishes.
 *
 * The directory form is NOT broken: Nx resolves `nx build secrets` to `@auto/secrets`
 * happily. Checked, because the opposite was assumed first. Naming the package is
 * simply the less ambiguous of two working forms, and the one that matches what
 * `nx show projects` prints.
 *
 * @param projectRoot - Absolute path to the generated project's directory.
 * @param projectName - The Nx project name, which is the package name.
 * @param testRunner - The workspace test runner, named in the test command.
 * @returns Nothing.
 * @throws Propagates any `fs` error raised while writing.
 * @typeParam None - this function has no generic type parameters.
 */
export function writeProjectReadme (
  projectRoot: string,
  projectName: string,
  testRunner: WorkspaceStack['testRunner'],
): void {
  const runner = testRunner === 'vitest' ? '[Vitest](https://vitest.dev)' : '[Jest](https://jestjs.io)'
  writeFileEnsured(
    join(projectRoot, 'README.md'),
    [
      `# ${projectName}`,
      '',
      'Generated by [MoNecromanCI](https://github.com/russoedu/MoNecromanCi).',
      '',
      '## Building',
      '',
      `Run \`nx build ${projectName}\` to build this project.`,
      '',
      '## Running unit tests',
      '',
      `Run \`nx test ${projectName}\` to execute the unit tests via ${runner}.`,
      '',
    ].join('\n'),
  )
}

/**
 * Removes the `.gitkeep` a directory no longer needs.
 *
 * @remarks
 * `create-nx-workspace` drops one into `packages/` and `libs/` so git tracks them
 * while empty. Once a real project lands there the file is not just redundant, it is
 * misleading - it says "this directory is empty" in a directory that is not.
 *
 * Swept across every scaffold directory rather than the one an `add` just wrote to,
 * so a workspace that predates this picks up the tidy on its next add regardless of
 * which kind was added.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Never - a missing file is the expected case on every later add.
 * @typeParam None - this function has no generic type parameters.
 */
export function removeStaleGitkeeps (workspaceRoot: string): void {
  for (const scaffold of ['apps', 'libs', 'packages']) {
    const directory = join(workspaceRoot, scaffold)
    try {
      const holdsAProject = readdirSync(directory, { withFileTypes: true }).some((entry) =>
        entry.isDirectory(),
      )
      if (holdsAProject) {
        rmSync(join(directory, '.gitkeep'), { force: true })
      }
    } catch {
      // The scaffold directory does not exist in this workspace; nothing to sweep.
    }
  }
}

/**
 * Ensures the `adm-zip` packager is a workspace devDependency.
 *
 * @remarks
 * Each app's `package` target zips its build output with `adm-zip` (pure JS,
 * cross-platform, no native build) so CI can pack apps on any agent OS. Shared
 * by every app kind that packages its own output (react-app, the Python
 * kinds); the function-app path folds the same install into its larger one.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Error when the install exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
export function ensureAdmZip (workspaceRoot: string): void {
  if (hasPlugin(workspaceRoot, 'adm-zip')) {
    return
  }
  logger.step('Installing the app packager (adm-zip)')
  if (
    runShell(
      'npm',
      ['install', '--save-dev', 'adm-zip', '--no-audit', '--no-fund'],
      workspaceRoot,
    ) !== 0
  ) {
    throw new Error('npm install of adm-zip failed')
  }
}

/**
 * Derives the default npm scope from the workspace's root package name.
 *
 * @remarks
 * Shared by the function-app and npm-lib kinds — both fall back to the
 * workspace's own scope when no `--scope` is given.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The scope, e.g. `@demo` for a workspace named `demo` (or
 * `@demo/source`-style names produced by some presets).
 * @throws Propagates any `fs`/JSON error reading the root manifest.
 * @typeParam None - this function has no generic type parameters.
 */
export function defaultScope (workspaceRoot: string): string {
  const { name } = readJson<{ name: string }>(join(workspaceRoot, 'package.json'))
  const base = (name.startsWith('@') ? name.slice(1) : name).split('/', 1)[0]

  return `@${base}`
}

/**
 * Merges extra Nx targets into an inference-only app via its manifest `nx` field.
 *
 * @remarks
 * Apps generated by `@nx/react:app`/`@nx/node:application` have no
 * `project.json` (targets are inferred), so extra targets (e.g. per-environment
 * builds, a `package` target) are attached through the package.json `nx`
 * field — merged with the inferred targets, and free of the project-name
 * clash a second `project.json` would risk in a TS-solution workspace. Shared
 * by every inference-only app kind that adds targets this way (react-app,
 * node-app, node-function-app).
 *
 * @param manifestPath - Absolute path to the app's `package.json`.
 * @param newTargets - The targets to merge in.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
export function addNxTargets (manifestPath: string, newTargets: Record<string, unknown>): void {
  // The generator always writes this manifest first (runAdd throws otherwise);
  // defaulting to {} only guards the pathological missing-file case.
  const manifest = fileExists(manifestPath) ? readJson<Record<string, unknown>>(manifestPath) : {}
  const nx = (manifest.nx as Record<string, unknown> | undefined) ?? {}
  const targets = (nx.targets as Record<string, unknown> | undefined) ?? {}
  writeFileEnsured(
    manifestPath,
    toJson({ ...manifest, nx: { ...nx, targets: { ...targets, ...newTargets } } }),
  )
}

/**
 * Merges extra targets into a project's `project.json`, creating it if the
 * plugin that generated the project wrote none.
 *
 * @remarks
 * Was identical, hand-duplicated code in `go.ts`, `python.ts` and
 * `flutter.ts` — each of those plugins writes a real `project.json` (`go`'s
 * with an empty `targets` map, since `@nx-go/nx-go`'s own inference needs a
 * per-project `go.mod` mnci's single-root-module layout does not have; Python
 * and Flutter's carry their own lint/test/build already). Extracted once a
 * fourth caller needed it: `@nx/dotnet` is inference-only and writes no
 * `project.json` at all, so `csharp.ts` needs this to also CREATE one — the
 * one behavioural difference from the three hand-duplicated originals, which
 * could assume the file already existed. Tolerating a missing file is a
 * strict widening: the three existing callers are unaffected, since their
 * generators always write the file first.
 *
 * @param projectJsonPath - Absolute path to the project's `project.json`.
 * @param newTargets - The targets to merge in.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the file.
 * @typeParam None - this function has no generic type parameters.
 */
export function addProjectJsonTargets (
  projectJsonPath: string,
  newTargets: Record<string, unknown>,
): void {
  const project = fileExists(projectJsonPath)
    ? readJson<Record<string, unknown>>(projectJsonPath)
    : {}
  const targets = (project.targets as Record<string, unknown> | undefined) ?? {}
  writeFileEnsured(projectJsonPath, toJson({ ...project, targets: { ...targets, ...newTargets } }))
}

/**
 * Every ESLint flat-config filename an `@nx/*` generator might write.
 *
 * @remarks
 * Nx picks the extension from the project's module type, so all of these are
 * reachable across the kinds mnci generates.
 */
const ESLINT_CONFIG_FILENAMES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
] as const

/**
 * Deletes the per-project ESLint config an `@nx/*` generator just wrote, and
 * any `.vscode/` directory it re-created.
 *
 * @remarks
 * An mnci workspace has exactly ONE ESLint config, at the root
 * (`@mnci/eslint-config`). Every `@nx/*` generator nevertheless drops an
 * `eslint.config.mjs` into the project it creates, which re-fragments the
 * config the moment a project is added.
 *
 * Deleting them is safe, and that was verified rather than assumed: with no
 * per-project config a project still gets its inferred `lint` target from
 * `@nx/eslint/plugin` (which maps config directories to the project roots
 * beneath them), `nx lint <project>` still runs, and it still reports real
 * violations from the root config. The e2e asserts both halves permanently,
 * because a future Nx change to that inference is the one thing that would
 * silently turn linting off across a whole workspace.
 *
 * `.vscode/` is handled here too: `@nx/node` re-creates `launch.json` on every
 * `add`, so removing it once at `mnci new` would not be enough.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param projectRoot - The new project's path, relative to the workspace root
 * (e.g. `apps/web`).
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error other than a missing path.
 * @typeParam None - this function has no generic type parameters.
 */
export function removeGeneratedEslintConfig (workspaceRoot: string, projectRoot: string): void {
  for (const filename of ESLINT_CONFIG_FILENAMES) {
    rmSync(join(workspaceRoot, projectRoot, filename), { force: true })
  }
  rmSync(join(workspaceRoot, '.vscode'), { recursive: true, force: true })
}

/**
 * The local-dev commands a newly added project actually has, for {@link registerProjectCommands}.
 *
 * @remarks
 * `qa` (lint then test) is unconditional — every kind has both — so it is not
 * a field here. `build` and `start` vary by kind: several (`go-lib`,
 * `python-internal-lib`, `flutter-lib`, ...) have no build target at all, and
 * only kinds with a genuine local dev-server story get `start` — never a
 * library, and not `go-function-app` (no Azure Functions custom-handler
 * wiring exists for Go yet, so a `func start` script would just fail).
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface ProjectCommands {
  /** Whether this kind has a `build` Nx target — adds `<name>:build` when true. */
  build:  boolean
  /**
   * The exact command for `<name>:start` (e.g. `nx run <name>:serve`,
   * `nx run <name>:start`) — omitted entirely when the kind has no local
   * dev-server story.
   */
  start?: string
}

/**
 * Finds the workspace's single `<name>.code-workspace` file.
 *
 * @remarks
 * Its filename is the workspace name, which `add/*.ts` call sites don't
 * otherwise track past `mnci new` — cheaper to look it up by extension than
 * to thread the name through every kind module.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The absolute path, or `undefined` when none exists (a workspace
 * predating this file, or a test fixture that never wrote one).
 * @throws Never - a missing/unreadable directory yields `undefined`.
 * @typeParam None - this function has no generic type parameters.
 */
function findCodeWorkspaceFile (workspaceRoot: string): string | undefined {
  try {
    const entry = readdirSync(workspaceRoot).find(file => file.endsWith('.code-workspace'))

    return entry ? join(workspaceRoot, entry) : undefined
  } catch {
    return undefined
  }
}

/**
 * One VS Code task for a project's script, matching its root `package.json` entry.
 *
 * @remarks
 * `start` tasks run a dev server that never exits on its own, so they are
 * marked `isBackground` (VS Code won't wait for them to finish) rather than
 * given a `group` — `build`/`qa` do exit, so they get the matching group
 * VS Code's Command Palette/Tasks menu groups them under.
 *
 * @param name - The project name.
 * @param kind - Which of the three commands this task runs.
 * @returns The VS Code task object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function projectTask (name: string, kind: 'build' | 'qa' | 'start'): Record<string, unknown> {
  const script = `${name}:${kind}`
  const base = { label: `${name}: ${kind}`, type: 'npm', script, problemMatcher: [] }

  return kind === 'start' ? { ...base, isBackground: true } : { ...base, group: kind }
}

/**
 * Registers a newly added project's local-dev commands: root `package.json`
 * scripts, and matching VS Code tasks in the workspace's `.code-workspace` file.
 *
 * @remarks
 * Every `add/*.ts` kind function calls this once it has finished generating
 * and target-wiring a project, so `npm run <name>:build`/`:qa`/`:start` (and
 * the equivalent VS Code Command Palette entries) work immediately — no
 * separate `mnci upgrade` needed, since these are per-project entries, not
 * one of the fixed files `applyOverlay()` regenerates.
 *
 * `<name>:qa` (`nx run <name>:lint && nx run <name>:test`) is unconditional.
 * `<name>:build`/`<name>:start` are added only when {@link ProjectCommands}
 * says the kind actually has them. Idempotent: repeat calls for the same
 * `name` (a second `add` of the same project) overwrite rather than
 * duplicate, in both the manifest scripts and the `.code-workspace` tasks
 * array. A workspace with no `.code-workspace` file (predates it, or a test
 * fixture) still gets the `package.json` scripts — only the VS Code half is
 * skipped.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The newly added project's name.
 * @param commands - Which commands this kind actually has.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing either file.
 * @typeParam None - this function has no generic type parameters.
 */
export function registerProjectCommands (
  workspaceRoot: string,
  name: string,
  commands: ProjectCommands,
): void {
  // Every `add` kind ends here, which makes this the one place the scaffold
  // `.gitkeep` files can be swept without wiring 30 call sites.
  removeStaleGitkeeps(workspaceRoot)
  const scripts: Record<string, string> = {
    [`${name}:qa`]: `nx run ${name}:lint && nx run ${name}:test`,
  }
  if (commands.build) {
    scripts[`${name}:build`] = `nx run ${name}:build`
  }
  if (commands.start) {
    scripts[`${name}:start`] = commands.start
  }

  // Re-derived after every add, because whether the pip/pub blocks belong
  // depends on what projects now EXIST, and this add may have created the
  // first one. Cheap (a directory scan) and idempotent. Skipped when the
  // workspace has no dependabot.yml, i.e. it was generated with --ci=azure.
  const dependabotPath = join(workspaceRoot, '.github/dependabot.yml')
  if (existsSync(dependabotPath)) {
    writeFileEnsured(dependabotPath, dependabotConfig(workspaceRoot))
  }

  const manifestPath = join(workspaceRoot, 'package.json')
  const manifest = readJson<Record<string, unknown>>(manifestPath)
  const existingScripts = (manifest.scripts as Record<string, string> | undefined) ?? {}
  // Synced on EVERY add, not only the express one, because the override depends
  // on the manifest's state rather than on which generator just ran — and this
  // runs after that generator has written its dependencies. `mnci add node-app
  // --framework express` is what introduces express, and the very next add would
  // otherwise be the one that fails. See reactExpressPeerOverride for why it is
  // conditional and why an unconditional form is worse than the bug.
  const overrides = {
    ...(manifest.overrides as Record<string, unknown> | undefined),
    ...reactExpressPeerOverride(manifest),
  }
  writeFileEnsured(
    manifestPath,
    toJson({
      ...manifest,
      scripts: { ...existingScripts, ...scripts },
      ...((Object.keys(overrides).length > 0) && { overrides }),
    }),
  )

  const codeWorkspacePath = findCodeWorkspaceFile(workspaceRoot)
  if (!codeWorkspacePath) {
    return
  }
  const workspaceFile =
    readCodeWorkspace<{
      tasks?: { version?: string; tasks?: Record<string, unknown>[] }
    }>(codeWorkspacePath) ?? {}
  const label = (task: Record<string, unknown>): string => (task.label as string | undefined) ?? ''
  const existingTasks = (workspaceFile.tasks?.tasks ?? []).filter(
    task => !label(task).startsWith(`${name}: `),
  )
  const newTasks = [
    projectTask(name, 'qa'),
    ...(commands.build ? [projectTask(name, 'build')] : []),
    ...(commands.start ? [projectTask(name, 'start')] : []),
  ]
  writeFileEnsured(
    codeWorkspacePath,
    toJson({
      ...workspaceFile,
      tasks: {
        version: workspaceFile.tasks?.version ?? '2.0.0',
        tasks:   [...existingTasks, ...newTasks],
      },
    }),
  )
}

/** Where a generated project's own manifest can live, in resolution order. */
const PROJECT_MANIFEST_ROOTS = ['apps', 'packages', 'libs'] as const

/**
 * Reads the root manifest's runtime dependencies.
 *
 * @remarks
 * Snapshotted before a generator runs so {@link relocateRootRuntimeDependencies}
 * can attribute what it added.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The `dependencies` block, or an empty object when unreadable.
 * @throws Never - an unreadable manifest reads as empty.
 * @typeParam None - this function has no generic type parameters.
 */
export function rootRuntimeDependencies (workspaceRoot: string): Record<string, string> {
  try {
    return (
      readJson<{ dependencies?: Record<string, string> }>(join(workspaceRoot, 'package.json'))
        .dependencies ?? {}
    )
  } catch {
    return {}
  }
}

/**
 * Moves runtime dependencies a generator hoisted to the root into the project.
 *
 * @remarks
 * **The root/project policy, applied rather than only checked.** `mnci doctor`
 * gained a `no runtime dependencies in the root manifest` check, and a freshly
 * generated workspace failed it: `@nx/react:application` puts `react` and
 * `react-dom` in the ROOT manifest, `--framework=express` puts `express` there,
 * and `add node-function-app` installs `@azure/functions` the same way. So mnci
 * generated workspaces its own doctor rejected — the "a gate that fails on day
 * one" shape this repo has hit before.
 *
 * The reason the policy matters is `@nx/rollup`, which externalises exactly what
 * a project's OWN manifest declares: a dependency left at the root is not shared,
 * it is **inlined as a private copy** into that project's published bundle. The
 * root is also `private` and never published, so a consumer of `@scope/lib` can
 * never resolve it.
 *
 * **Attribution is by diff, not by guessing what a project imports.** Whatever
 * appeared in the root's `dependencies` while this generator ran belongs to the
 * project it just generated — accurate by construction, and it needs no import
 * analysis and no per-kind list to keep in sync as kinds are added.
 *
 * A value the project already declares **wins**: `add node-function-app` stamps
 * `@azure/functions` into the app manifest at the exact installed version, which
 * is more precise than the root's range.
 *
 * The lockfile is refreshed, because moving a dependency between manifests
 * leaves it stale. Measured: npm 10.9.7 runs `npm ci` against the stale lock
 * without complaint, which is leniency rather than correctness — the lock still
 * recorded the dependency against the root — and this repo has been bitten by
 * npm 10/11 divergence three times. A failure here warns rather than throws: the
 * project is already generated, and the remedy is one `npm install`.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param projectName - The project just generated.
 * @param before - The root `dependencies` snapshot taken before the generator ran.
 * @returns Nothing.
 * @throws Never - an unreadable or absent project manifest leaves the root alone.
 * @typeParam None - this function has no generic type parameters.
 */
export function relocateRootRuntimeDependencies (
  workspaceRoot: string,
  projectName: string,
  before: Record<string, string>,
): void {
  const after = rootRuntimeDependencies(workspaceRoot)
  const added = Object.keys(after).filter(name => !Object.hasOwn(before, name))
  if (added.length === 0) {
    return
  }

  const manifestPath = PROJECT_MANIFEST_ROOTS.map(root =>
    join(workspaceRoot, root, projectName, 'package.json'),
  ).find(candidate => fileExists(candidate))
  if (manifestPath === undefined) {
    // Nothing to move them INTO — a Python, Go or Dart project has no npm
    // manifest. Leaving the root untouched is the honest outcome: dropping the
    // declaration would break resolution for whatever does need it.
    return
  }

  const manifest = readJson<Record<string, unknown>>(manifestPath)
  const owned = (manifest.dependencies as Record<string, string> | undefined) ?? {}
  // `owned` is spread LAST so a value the project already declares wins, and
  // that ordering is the only mechanism enforcing it — filtering `moved` as
  // well would be a second, redundant guard that makes neither testable.
  const moved = Object.fromEntries(added.map(name => [name, after[name]]))
  writeFileEnsured(manifestPath, toJson({ ...manifest, dependencies: { ...moved, ...owned } }))

  const remaining = Object.fromEntries(
    Object.entries(after).filter(([name]) => !added.includes(name)),
  )
  const rootManifest = readJson<Record<string, unknown>>(join(workspaceRoot, 'package.json'))
  const { dependencies: _dropped, ...rest } = rootManifest
  writeFileEnsured(
    join(workspaceRoot, 'package.json'),
    toJson(Object.keys(remaining).length > 0 ? { ...rest, dependencies: remaining } : rest),
  )
  logger.step(`Moved ${added.join(', ')} into ${projectName}'s own manifest`)

  if (
    runShell(
      'npm',
      ['install', '--package-lock-only', '--no-audit', '--no-fund'],
      workspaceRoot,
    ) !== 0
  ) {
    logger.warn(
      `Could not refresh package-lock.json after moving ${added.join(', ')}. Run 'npm install'.`,
    )
  }
}
