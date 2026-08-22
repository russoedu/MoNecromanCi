import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runNx, runShell } from '../../nx'
import { fileExists, readCodeWorkspace, readJson, toJson, writeFileEnsured } from '../../util/fsx'
import { logger } from '../../util/logger'

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
  scope?: string
  /** `node-app` only: the HTTP framework `@nx/node:application` scaffolds (defaults to `none`, a bare Node app). */
  framework?: NodeFramework
  /** `python-vendor` only: the internal Python library (under `libs/`) to vendor into `name`. */
  lib?: string
}

/**
 * The workspace stack, generator-facing shape (what `readWorkspaceStack` in
 * `add.ts` resolves and every plugin-generated kind consumes).
 *
 * @remarks
 * Only testRunner is configurable; linting is always ESLint + Prettier.
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
    dependencies?: Record<string, string>
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
      workspaceRoot
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
    toJson({ ...manifest, nx: { ...nx, targets: { ...targets, ...newTargets } } })
  )
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
  'eslint.config.cts'
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
  build: boolean
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
  commands: ProjectCommands
): void {
  const scripts: Record<string, string> = {
    [`${name}:qa`]: `nx run ${name}:lint && nx run ${name}:test`
  }
  if (commands.build) {
    scripts[`${name}:build`] = `nx run ${name}:build`
  }
  if (commands.start) {
    scripts[`${name}:start`] = commands.start
  }

  const manifestPath = join(workspaceRoot, 'package.json')
  const manifest = readJson<Record<string, unknown>>(manifestPath)
  const existingScripts = (manifest.scripts as Record<string, string> | undefined) ?? {}
  writeFileEnsured(
    manifestPath,
    toJson({ ...manifest, scripts: { ...existingScripts, ...scripts } })
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
    task => !label(task).startsWith(`${name}: `)
  )
  const newTasks = [
    projectTask(name, 'qa'),
    ...(commands.build ? [projectTask(name, 'build')] : []),
    ...(commands.start ? [projectTask(name, 'start')] : [])
  ]
  writeFileEnsured(
    codeWorkspacePath,
    toJson({
      ...workspaceFile,
      tasks: {
        version: workspaceFile.tasks?.version ?? '2.0.0',
        tasks: [...existingTasks, ...newTasks]
      }
    })
  )
}
