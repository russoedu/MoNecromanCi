import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { runFormatter, runNpx, runShell } from '../nx'
import {
  applyOverlay,
  DEFAULT_STACK,
  type CiProvider,
  type RegistryConfig,
  type StackConfig
} from '../overlay'
import { promptCi, promptNxCloud, promptRegistry, promptStack, promptText } from '../prompts'
import { logger } from '../util/logger'
import { assertValidProjectName } from '../util/names'

/**
 * Options accepted by {@link runNew}.
 *
 * @remarks
 * Mirrors the CLI's flags; every field left `undefined` is prompted for
 * interactively (unless `yes` short-circuits to defaults).
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface NewOptions {
  /** Skip prompts, accepting defaults for everything not passed as a flag. */
  yes?: boolean
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
  /** Opt in to Nx Cloud (remote caching + CI insights). Default: not connected. */
  nxCloud?: boolean
}

/**
 * Maps the chosen CI provider to the `create-nx-workspace --nxCloud` value
 * used when opting in.
 *
 * @remarks
 * Deliberately never `--nxCloud=yes` (the provider-agnostic value): verified
 * empirically that it prompts "Will you be using GitHub as your git hosting
 * provider?" even with `--useGitHub` and `--no-interactive` both set, and
 * exits without creating the workspace at all when stdin is not a TTY — a
 * real upstream inconsistency in `create-nx-workspace`, not something this
 * CLI can configure around. A named provider (`github`/`azure`/…) sidesteps
 * that prompt entirely and completes non-interactively every time.
 *
 * The provider value only controls the throwaway CI workflow file
 * `create-nx-workspace` writes as a side effect of Cloud setup — this CLI's
 * own {@link applyOverlay} unconditionally overwrites whatever lands at that
 * same path right after, so the specific value has no visible effect beyond
 * avoiding the hang. `both` has no Nx equivalent, so it maps to `github`
 * (arbitrary but harmless, for the same reason).
 *
 * @param ci - The chosen CI provider.
 * @returns The `--nxCloud` value to pass when Nx Cloud is opted into.
 * @throws Never - pure mapping.
 * @typeParam None - this function has no generic type parameters.
 */
function nxCloudProviderValue (ci: CiProvider): 'github' | 'azure' {
  return ci === 'azure' ? 'azure' : 'github'
}

/**
 * Resolves the stack from flags, prompts, or `--yes` defaults.
 *
 * @remarks
 * The testRunner flag is taken as-is if passed; otherwise the interactive
 * {@link promptStack} runs and fills the gap, or `--yes` uses the default.
 *
 * @param options - The CLI flags.
 * @returns The resolved stack configuration.
 * @throws Propagates prompt errors (e.g. when stdin is not a TTY).
 * @typeParam None - this function has no generic type parameters.
 */
async function resolveStack (options: NewOptions): Promise<StackConfig> {
  // The flag skips the prompt entirely: the stack is one choice now that the
  // linter is no longer part of it.
  if (options.testRunner || options.yes) {
    return { testRunner: options.testRunner ?? DEFAULT_STACK.testRunner }
  }
  const prompted = await promptStack()
  return { testRunner: prompted.testRunner }
}

/**
 * Resolves the CI provider from a flag, `--yes`'s default, or a prompt.
 *
 * @remarks
 * `azure` stays the `--yes`/flagless default — the long-standing behaviour —
 * so an existing flagless `mnci new` keeps writing exactly the same file it
 * always has. An explicit flag value is trusted as-is with no validation
 * (matching `resolveRegistry`'s equally loose `--registry` handling): a
 * typo just falls through to the flagless default instead of prompting.
 *
 * @param options - The CLI flags.
 * @returns The resolved CI provider.
 * @throws Propagates prompt errors (e.g. when stdin is not a TTY).
 * @typeParam None - this function has no generic type parameters.
 */
const CI_PROVIDERS: ReadonlySet<CiProvider> = new Set(['azure', 'github', 'both'])

async function resolveCi (options: NewOptions): Promise<CiProvider> {
  if (options.ci && CI_PROVIDERS.has(options.ci)) {
    return options.ci
  }
  if (options.yes) {
    return 'azure'
  }
  return await promptCi()
}

/**
 * Resolves the registry configuration from flags, prompts or defaults.
 *
 * @param options - The CLI flags.
 * @returns The resolved registry configuration.
 * @throws Propagates prompt errors (e.g. when stdin is not a TTY).
 * @typeParam None - this function has no generic type parameters.
 */
async function resolveRegistry (options: NewOptions): Promise<RegistryConfig> {
  if (options.registry === 'azure-artifacts' || (options.organization && options.artifactsFeed)) {
    return {
      kind: 'azure-artifacts',
      organization: options.organization ?? (await promptText('Azure DevOps organization')),
      project: options.project ?? (await promptText('Azure DevOps project')),
      artifactsFeed: options.artifactsFeed ?? (await promptText('Artifacts feed name'))
    }
  }
  if (options.registry === 'npm' || options.yes) {
    return { kind: 'npm' }
  }
  return await promptRegistry()
}

/**
 * Creates a brand-new monorepo: Nx's own TS preset plus this CLI's overlay.
 *
 * @remarks
 * The heavy lifting is `create-nx-workspace --preset=ts` (npm workspaces +
 * TypeScript project references, no per-project `project.json`). This then
 * applies its one layer of opinion ({@link applyOverlay}) and installs the
 * conventional-commit toolchain (`husky` + `@commitlint/*`) for real, so the
 * versions resolve at generation time.
 *
 * @param name - The workspace (and directory) name.
 * @param options - The CLI flags.
 * @returns A promise that resolves when the workspace is ready.
 * @throws Error when any underlying command exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runNew (name: string | undefined, options: NewOptions): Promise<void> {
  const workspaceName = name ?? (await promptText('Workspace name'))
  // Fails fast, before any further prompt or side effect: the name becomes a
  // directory, a `create-nx-workspace` argument and (derived) an npm scope, so
  // a bad one should never get this far — and an explicitly empty `name`
  // argument bypasses promptText's own non-empty check, which only fires on
  // the prompted path.
  assertValidProjectName(workspaceName, 'Workspace name')
  const scope =
    options.scope ??
    (options.yes
      ? `@${workspaceName}`
      : await promptText('npm scope for publishable packages', `@${workspaceName}`))
  const registry = await resolveRegistry(options)
  const ci = await resolveCi(options)
  const agent =
    options.agent ??
    (options.yes
      ? 'ubuntu-latest'
      : await promptText(
          'CI build agent/runner (vmImage, GitHub Actions runner label, or self-hosted pool name)',
          'ubuntu-latest'
        ))
  // The variable group is an Azure Pipelines concept (GitHub reads a plain
  // `PAT` repository secret instead, no CLI-collected name needed) — skipped
  // when Azure is not one of the chosen providers.
  const variableGroup =
    ci === 'github'
      ? (options.variableGroup ?? 'Build')
      : (options.variableGroup ??
        (options.yes
          ? 'Build'
          : await promptText('Azure DevOps variable group holding the npm PAT', 'Build')))
  const stack = await resolveStack(options)
  const nxCloud = options.nxCloud ?? (options.yes ? false : await promptNxCloud())

  logger.step(`Creating Nx workspace '${workspaceName}' (preset: ts)`)
  runNpx(
    [
      '--yes',
      'create-nx-workspace@latest',
      workspaceName,
      '--preset=ts',
      '--pm=npm',
      nxCloud ? `--nxCloud=${nxCloudProviderValue(ci)}` : '--nxCloud=skip',
      '--no-interactive'
    ],
    process.cwd()
  )

  const workspaceRoot = join(process.cwd(), workspaceName)

  logger.step(
    'Applying MoNecromanCI overlay (VS Code workspace, release config, .npmrc, commitlint, pipeline, stack)'
  )
  applyOverlay(workspaceRoot, { workspaceName, scope, registry, agent, variableGroup, ci, stack })

  // npm honours `overrides` only when it RESOLVES a tree, and by this point
  // `create-nx-workspace` has already installed one and written its lockfile —
  // both without the overrides `applyOverlay` just added. npm then reuses that
  // tree wholesale on the next install, so the overrides are silently ignored.
  //
  // This is not theoretical, and it is npm-version dependent, which is what
  // made it survive three nightlies. Reproduced on nx 23.1.1, which nests a
  // vulnerable `brace-expansion@5.0.8` under `node_modules/nx`:
  //
  //   npm 10.9.7  create → overlay → install  →  0 advisories
  //   npm 11.19.0 create → overlay → install  →  6 advisories
  //
  // So the generated workspace shipped six high advisories while this repo —
  // whose own lockfile was resolved WITH the overrides present — read 0, and
  // every local check agreed with the wrong one.
  //
  // Both artifacts have to go. Removing only the lockfile still reports 6 under
  // npm 11: an existing `node_modules` is by itself enough for npm to keep the
  // stale tree. Measured both ways rather than assumed.
  rmSync(join(workspaceRoot, 'node_modules'), { recursive: true, force: true })
  rmSync(join(workspaceRoot, 'package-lock.json'), { force: true })

  // One install. It also pulls in everything `applyOverlay` just added to the
  // manifest — Prettier, ESLint and `@mnci/eslint-config` — which is why the
  // formatting pass below can run immediately after. It resolves from scratch,
  // by construction of the two removals above.
  logger.step('Installing the toolchain (commitlint + husky + linting/formatting)')
  const installStatus = runShell(
    'npm',
    ['install', '--save-dev', 'husky', '@commitlint/cli', '@commitlint/config-conventional'],
    workspaceRoot
  )
  if (installStatus !== 0) {
    throw new Error(`npm install of the toolchain failed with exit code ${installStatus}`)
  }
  // The overlay already stamped `prepare: husky` into the root scripts.
  runShell('npx', ['husky'], workspaceRoot)

  // `create-nx-workspace` wrote its scaffold in its own style, which is not
  // mnci's. Normalise it now so the workspace passes its own `lint` from the
  // very first commit.
  logger.step('Formatting the workspace (eslint --fix, JavaScript Standard Style)')
  runFormatter(workspaceRoot)

  logger.success('Done. Next steps:')
  logger.info(`  cd ${workspaceName}`)
  logger.info('  mnci add react-app web        # or: react-lib, react-internal-lib, node-app,')
  logger.info('                                 #     node-function-app, npm-lib, internal-lib,')
  logger.info(
    '                                 #     python-app, python-function-app, python-lib, python-internal-lib,'
  )
  logger.info(
    '                                 #     go-app, go-function-app, go-lib, go-internal-lib,'
  )
  logger.info(
    '                                 #     flutter-app, flutter-lib, flutter-internal-lib'
  )
  logger.info('  git add -A && git commit -m "feat: initial workspace"')
}
