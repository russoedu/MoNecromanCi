import { join } from 'node:path'
import { runShell } from '../../nx'
import { readJson } from '../../util/fsx'
import { logger } from '../../util/logger'

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
}

/**
 * The workspace stack, generator-facing shape (what `readWorkspaceStack` in
 * `add.ts` resolves and every plugin-generated kind consumes).
 *
 * @remarks
 * `linter` is the value passed straight to `@nx/*` generators — `eslint`, or
 * `none` when the workspace chose oxlint (oxlint is not an Nx linter).
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface WorkspaceStack {
  linter:     'eslint' | 'none'
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
  const manifest = readJson<{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }>(join(workspaceRoot, 'package.json'))
  const installed = { ...manifest.dependencies, ...manifest.devDependencies }
  return Object.hasOwn(installed, packageName)
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
  if (runShell('npm', ['install', '--save-dev', 'adm-zip', '--no-audit', '--no-fund'], workspaceRoot) !== 0) {
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
