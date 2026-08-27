import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { runFormatter } from '../nx'
import {
  applyOverlay,
  readMnciConfig,
  type CiProvider,
  type OverlayOptions,
  type RegistryConfig,
  type StackConfig
} from '../overlay'
import { fileExists } from '../util/fsx'
import { logger } from '../util/logger'

/**
 * Options accepted by {@link runUpgrade}.
 *
 * @remarks
 * Mirrors `mnci new`'s flags exactly — an explicit flag overrides whatever
 * `mnci new`/a previous `upgrade` persisted in `nx.json`'s `mnci` block
 * ({@link readMnciConfig}); everything left `undefined` falls back to that
 * persisted value. Unlike `new`, there is no `--yes`/prompt fallback: a
 * workspace missing a persisted field (predates persistence, or had it
 * hand-edited away) needs that one flag passed explicitly, reported as a
 * clear error rather than guessed or prompted for.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface UpgradeOptions {
  /** The npm scope for publishable packages (e.g. `@demo`). */
  scope?: string
  /** Registry kind: `azure-artifacts` or `npm`. */
  registry?: RegistryConfig['kind']
  /** Azure DevOps organization (azure-artifacts only). */
  organization?: string
  /** Azure DevOps project (azure-artifacts only). */
  project?: string
  /** Azure Artifacts feed name (azure-artifacts only). */
  artifactsFeed?: string
  /** CI build agent — a Microsoft-hosted vmImage or a self-hosted pool name. */
  agent?: string
  /** Library variable group holding the base64 npm `PAT`. */
  variableGroup?: string
  /** CI provider: `azure` | `github` | `both`. */
  ci?: CiProvider
  /** Unit-test runner (`jest` or `vitest`). */
  testRunner?: StackConfig['testRunner']
}

/**
 * Resolves the registry from flags, falling back to whatever is persisted.
 *
 * @remarks
 * Mirrors `new.ts`'s `resolveRegistry`, minus the interactive-prompt
 * fallback: `upgrade` is as likely to run unattended (a script, a CI step)
 * as interactively, so a genuinely missing value is a clear thrown error,
 * not a prompt that would hang a non-interactive run.
 *
 * @param options - The CLI flags.
 * @param persisted - The registry persisted in `nx.json`'s `mnci` block, if any.
 * @returns The resolved registry configuration.
 * @throws Error when Azure Artifacts coordinates or a registry kind cannot
 * be resolved from either flags or the persisted config.
 * @typeParam None - this function has no generic type parameters.
 */
function resolveRegistry (
  options: UpgradeOptions,
  persisted: RegistryConfig | undefined
): RegistryConfig {
  if (options.registry === 'azure-artifacts' || (options.organization && options.artifactsFeed)) {
    const persistedAzure = persisted?.kind === 'azure-artifacts' ? persisted : undefined
    const organization = options.organization ?? persistedAzure?.organization
    const project = options.project ?? persistedAzure?.project
    const artifactsFeed = options.artifactsFeed ?? persistedAzure?.artifactsFeed
    if (!organization || !project || !artifactsFeed) {
      throw new Error(
        "Azure Artifacts registry needs --organization, --project and --artifacts-feed (none found in nx.json's persisted config either)."
      )
    }
    return { kind: 'azure-artifacts', organization, project, artifactsFeed }
  }
  if (options.registry === 'npm') {
    return { kind: 'npm' }
  }
  if (persisted) {
    return persisted
  }
  throw new Error(
    "No registry found in nx.json's persisted config. Pass --registry npm or --registry azure-artifacts (with --organization/--project/--artifacts-feed)."
  )
}

/**
 * The workspace's own name, for the `<name>.code-workspace` file the overlay writes.
 *
 * @remarks
 * This exists because `resolveOverlayOptions` used to omit `workspaceName`
 * entirely, so `applyOverlay` interpolated `undefined` and every `mnci upgrade`
 * wrote a file literally named `undefined.code-workspace` — while the
 * workspace's real one was never rewritten, making the `.code-workspace` the one
 * mnci-owned file an upgrade could not actually carry a fix into.
 *
 * A fallback chain rather than a single source, because the authoritative one is
 * only available going forward:
 *
 * 1. **The persisted `mnci.workspaceName`** — written by `mnciConfig` as of this
 *    fix, so correct for anything generated or upgraded from now on.
 * 2. **An existing `*.code-workspace` filename** — accurate for a workspace
 *    generated before that field was persisted. `undefined.code-workspace` is
 *    skipped explicitly: a workspace carrying junk from the old bug would
 *    otherwise resolve its name as the string `undefined` and keep reproducing
 *    it forever.
 * 3. **The directory basename** — what `create-nx-workspace` names the directory,
 *    so it is right in the ordinary case and always available.
 *
 * The root `package.json` name is deliberately *not* in the chain: it is
 * `@<scope>/source`, which carries the scope rather than the workspace name, and
 * the two differ whenever `--scope` was passed explicitly.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param persisted - Whatever `mnci new`/a previous `upgrade` persisted.
 * @returns The workspace name.
 * @throws Never - an unreadable directory falls through to the basename.
 * @typeParam None - this function has no generic type parameters.
 */
function resolveWorkspaceName (workspaceRoot: string, persisted: Partial<OverlayOptions>): string {
  if (persisted.workspaceName) {
    return persisted.workspaceName
  }
  try {
    const existing = readdirSync(workspaceRoot).find(
      file => file.endsWith('.code-workspace') && file !== 'undefined.code-workspace'
    )
    if (existing) {
      return existing.replace(/\.code-workspace$/, '')
    }
  } catch {
    // Fall through to the basename.
  }
  return basename(workspaceRoot)
}

/**
 * Resolves the full overlay options a `mnci upgrade` run applies: an
 * explicit flag wins field-by-field, otherwise the persisted `mnci` block
 * (see {@link readMnciConfig}) is the default.
 *
 * @param workspaceRoot - Absolute path to the workspace, for
 * {@link resolveWorkspaceName}'s filename and basename fallbacks.
 * @param options - The CLI flags.
 * @param persisted - Whatever `mnci new`/a previous `upgrade` persisted.
 * @returns The fully resolved overlay options.
 * @throws Error when a required field is missing from both the flags and
 * the persisted config, naming the flag needed to supply it.
 * @typeParam None - this function has no generic type parameters.
 */
function resolveOverlayOptions (
  workspaceRoot: string,
  options: UpgradeOptions,
  persisted: Partial<OverlayOptions>
): OverlayOptions {
  const scope = options.scope ?? persisted.scope
  if (!scope) {
    throw new Error("No npm scope found in nx.json's persisted config. Pass --scope explicitly.")
  }
  const registry = resolveRegistry(options, persisted.registry)
  const ci = options.ci ?? persisted.ci
  if (!ci) {
    throw new Error(
      "No CI provider found in nx.json's persisted config. Pass --ci azure|github|both explicitly."
    )
  }
  const agent = options.agent ?? persisted.agent
  if (!agent) {
    throw new Error(
      "No CI build agent found in nx.json's persisted config. Pass --agent explicitly."
    )
  }
  // Azure-only concept; a github-only workspace never needed one, so a
  // missing persisted value is not an error the way scope/ci/agent are.
  const variableGroup = options.variableGroup ?? persisted.variableGroup ?? 'Build'
  // Defaults to `eslint` rather than erroring when absent, unlike testRunner
  const testRunner = options.testRunner ?? persisted.stack?.testRunner
  if (!testRunner) {
    throw new Error(
      "No testRunner found in nx.json's persisted config. Pass --test-runner explicitly."
    )
  }

  return {
    workspaceName: resolveWorkspaceName(workspaceRoot, persisted),
    scope,
    registry,
    agent,
    variableGroup,
    ci,
    stack: { testRunner }
  }
}

/**
 * Re-applies the latest MoNecromanCI overlay to an already-generated
 * workspace.
 *
 * @remarks
 * Every improvement to `overlay.ts` since a workspace's `mnci new` only ever
 * reached *future* workspaces until now — nothing let an existing one pick
 * up a later fix (the tag-push ordering fix, the global Python workspace
 * install, the Windows `python`/`python3` resolution, all landed this way).
 * `upgrade` closes that gap: it resolves the same {@link OverlayOptions}
 * `new` would have (explicit flags over whatever `mnci new` persisted — see
 * {@link resolveOverlayOptions}) and calls {@link applyOverlay} again, the
 * exact same pure, idempotent file-writer `new` itself calls. No diffing or
 * confirmation prompt: every file `applyOverlay` touches is `mnci`-owned
 * (`nx.json`'s `release`/`sync`/`generators`/`mnci` blocks, `.npmrc`,
 * `commitlint.config.mjs`, `.husky/commit-msg`, the CI pipeline file(s), and
 * the curated root `package.json` scripts), and virtually every generated
 * workspace is already a git repo — `git diff` is the review step, not a
 * bespoke one built here.
 *
 * @param workspaceRoot - Absolute path to the workspace to upgrade (the
 * current working directory).
 * @param options - The CLI flags.
 * @returns Nothing.
 * @throws Error when `workspaceRoot` is not an `mnci`-generated workspace,
 * or a required field is missing from both the flags and the persisted
 * config.
 * @typeParam None - this function has no generic type parameters.
 */
export function runUpgrade (workspaceRoot: string, options: UpgradeOptions): void {
  if (!fileExists(join(workspaceRoot, 'nx.json'))) {
    throw new Error(
      `No nx.json found in ${workspaceRoot} — this does not look like an Nx workspace. Run 'mnci upgrade' from the workspace root.`
    )
  }
  const persisted = readMnciConfig(workspaceRoot)
  const resolved = resolveOverlayOptions(workspaceRoot, options, persisted)

  logger.step('Re-applying the MoNecromanCI overlay')
  applyOverlay(workspaceRoot, resolved, logger.detail)

  // `new` and every `add` end this way; `upgrade` did not, so it left the
  // `nx.json` it had just rewritten mis-formatted — which now fails the
  // workspace's own `format:check` CI gate. Non-fatal for the same reason it is
  // there: the overlay is already applied by this point.
  //
  // Announced because it is by far the slowest part of an upgrade — `eslint --fix`
  // over the whole workspace — and it used to run in silence after the overlay
  // message, so a large workspace looked hung for a minute or more. `new` already
  // logged this; `upgrade` did not.
  logger.step(
    'Formatting the workspace (eslint --fix) — the slowest step, minutes on a large workspace'
  )
  runFormatter(workspaceRoot)

  logger.success('Done. Review the changes with `git diff` before committing.')
}
