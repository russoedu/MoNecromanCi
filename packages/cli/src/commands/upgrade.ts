import { join } from 'node:path'
import { applyOverlay, readMnciConfig, type CiProvider, type OverlayOptions, type RegistryConfig, type StackConfig } from '../overlay'
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
  scope?:         string
  /** Registry kind: `azure-artifacts` or `npm`. */
  registry?:      RegistryConfig['kind']
  /** Azure DevOps organization (azure-artifacts only). */
  organization?:  string
  /** Azure DevOps project (azure-artifacts only). */
  project?:       string
  /** Azure Artifacts feed name (azure-artifacts only). */
  artifactsFeed?: string
  /** CI build agent — a Microsoft-hosted vmImage or a self-hosted pool name. */
  agent?:         string
  /** Library variable group holding the base64 npm `PAT`. */
  variableGroup?: string
  /** CI provider: `azure` | `github` | `both`. */
  ci?:            CiProvider
  /** Linter (`eslint` or `oxlint`). */
  linter?:        StackConfig['linter']
  /** Unit-test runner (`jest` or `vitest`). */
  testRunner?:    StackConfig['testRunner']
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
function resolveRegistry (options: UpgradeOptions, persisted: RegistryConfig | undefined): RegistryConfig {
  if (options.registry === 'azure-artifacts' || (options.organization && options.artifactsFeed)) {
    const persistedAzure = persisted?.kind === 'azure-artifacts' ? persisted : undefined
    const organization = options.organization ?? persistedAzure?.organization
    const project = options.project ?? persistedAzure?.project
    const artifactsFeed = options.artifactsFeed ?? persistedAzure?.artifactsFeed
    if (!organization || !project || !artifactsFeed) {
      throw new Error('Azure Artifacts registry needs --organization, --project and --artifacts-feed (none found in nx.json\'s persisted config either).')
    }
    return { kind: 'azure-artifacts', organization, project, artifactsFeed }
  }
  if (options.registry === 'npm') {
    return { kind: 'npm' }
  }
  if (persisted) {
    return persisted
  }
  throw new Error('No registry found in nx.json\'s persisted config. Pass --registry npm or --registry azure-artifacts (with --organization/--project/--artifacts-feed).')
}

/**
 * Resolves the full overlay options a `mnci upgrade` run applies: an
 * explicit flag wins field-by-field, otherwise the persisted `mnci` block
 * (see {@link readMnciConfig}) is the default.
 *
 * @param options - The CLI flags.
 * @param persisted - Whatever `mnci new`/a previous `upgrade` persisted.
 * @returns The fully resolved overlay options.
 * @throws Error when a required field is missing from both the flags and
 * the persisted config, naming the flag needed to supply it.
 * @typeParam None - this function has no generic type parameters.
 */
function resolveOverlayOptions (options: UpgradeOptions, persisted: Partial<OverlayOptions>): OverlayOptions {
  const scope = options.scope ?? persisted.scope
  if (!scope) {
    throw new Error('No npm scope found in nx.json\'s persisted config. Pass --scope explicitly.')
  }
  const registry = resolveRegistry(options, persisted.registry)
  const ci = options.ci ?? persisted.ci
  if (!ci) {
    throw new Error('No CI provider found in nx.json\'s persisted config. Pass --ci azure|github|both explicitly.')
  }
  const agent = options.agent ?? persisted.agent
  if (!agent) {
    throw new Error('No CI build agent found in nx.json\'s persisted config. Pass --agent explicitly.')
  }
  // Azure-only concept; a github-only workspace never needed one, so a
  // missing persisted value is not an error the way scope/ci/agent are.
  const variableGroup = options.variableGroup ?? persisted.variableGroup ?? 'Build'
  const linter = options.linter ?? persisted.stack?.linter
  const testRunner = options.testRunner ?? persisted.stack?.testRunner
  if (!linter || !testRunner) {
    throw new Error('No stack (linter/test runner) found in nx.json\'s persisted config. Pass --linter and --test-runner explicitly.')
  }

  return { scope, registry, agent, variableGroup, ci, stack: { linter, testRunner } }
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
    throw new Error(`No nx.json found in ${workspaceRoot} — this does not look like an Nx workspace. Run 'mnci upgrade' from the workspace root.`)
  }
  const persisted = readMnciConfig(workspaceRoot)
  const resolved = resolveOverlayOptions(options, persisted)

  logger.step('Re-applying the MoNecromanCI overlay (release config, .npmrc, commitlint, pipeline, stack)')
  applyOverlay(workspaceRoot, resolved)

  logger.success('Done. Review the changes with `git diff` before committing.')
}
