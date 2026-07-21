import { join } from 'node:path'
import { runNpx, runShell } from '../nx'
import { applyOverlay, DEFAULT_STACK, type CiProvider, type RegistryConfig, type StackConfig } from '../overlay'
import { promptCi, promptRegistry, promptStack, promptText } from '../prompts'
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
  yes?:           boolean
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
 * Resolves the stack from flags, prompts, or `--yes` defaults.
 *
 * @remarks
 * Any of the three knobs passed as a flag is taken as-is; if all three are
 * passed (or `--yes` is set) nothing is prompted. Otherwise the interactive
 * {@link promptStack} runs and its answers fill the gaps.
 *
 * @param options - The CLI flags.
 * @returns The resolved stack configuration.
 * @throws Propagates prompt errors (e.g. when stdin is not a TTY).
 * @typeParam None - this function has no generic type parameters.
 */
async function resolveStack (options: NewOptions): Promise<StackConfig> {
  const fromFlags = { linter: options.linter, testRunner: options.testRunner }
  const complete = Boolean(fromFlags.linter && fromFlags.testRunner)
  if (complete || options.yes) {
    return {
      linter:     fromFlags.linter ?? DEFAULT_STACK.linter,
      testRunner: fromFlags.testRunner ?? DEFAULT_STACK.testRunner,
    }
  }
  const prompted = await promptStack()
  return {
    linter:     fromFlags.linter ?? prompted.linter,
    testRunner: fromFlags.testRunner ?? prompted.testRunner,
  }
}

/**
 * Resolves the CI provider from a flag, `--yes`'s default, or a prompt.
 *
 * @remarks
 * `azure` stays the `--yes`/flagless default — the long-standing behaviour —
 * so an existing flagless `mnci2 new` keeps writing exactly the same file it
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
      kind:          'azure-artifacts',
      organization:  options.organization ?? await promptText('Azure DevOps organization'),
      project:       options.project ?? await promptText('Azure DevOps project'),
      artifactsFeed: options.artifactsFeed ?? await promptText('Artifacts feed name'),
    }
  }
  if (options.registry === 'npm' || options.yes) {
    return { kind: 'npm' }
  }
  return await promptRegistry()
}

/**
 * Creates a brand-new monorepo: Nx's own TS preset plus the v2 overlay.
 *
 * @remarks
 * The heavy lifting is `create-nx-workspace --preset=ts` (npm workspaces +
 * TypeScript project references, no per-project `project.json`). v2 then
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
  const workspaceName = name ?? await promptText('Workspace name')
  // Fails fast, before any further prompt or side effect: the name becomes a
  // directory, a `create-nx-workspace` argument and (derived) an npm scope, so
  // a bad one should never get this far — and an explicitly empty `name`
  // argument bypasses promptText's own non-empty check, which only fires on
  // the prompted path.
  assertValidProjectName(workspaceName, 'Workspace name')
  const scope = options.scope ?? (options.yes ? `@${workspaceName}` : await promptText('npm scope for publishable packages', `@${workspaceName}`))
  const registry = await resolveRegistry(options)
  const ci = await resolveCi(options)
  const agent = options.agent ?? (options.yes ? 'ubuntu-latest' : await promptText('CI build agent/runner (vmImage, GitHub Actions runner label, or self-hosted pool name)', 'ubuntu-latest'))
  // The variable group is an Azure Pipelines concept (GitHub reads a plain
  // `PAT` repository secret instead, no CLI-collected name needed) — skipped
  // when Azure is not one of the chosen providers.
  const variableGroup = ci === 'github'
    ? (options.variableGroup ?? 'Build')
    : options.variableGroup ?? (options.yes ? 'Build' : await promptText('Azure DevOps variable group holding the npm PAT', 'Build'))
  const stack = await resolveStack(options)

  logger.step(`Creating Nx workspace '${workspaceName}' (preset: ts)`)
  runNpx([
    '--yes',
    'create-nx-workspace@latest',
    workspaceName,
    '--preset=ts',
    '--pm=npm',
    '--nxCloud=skip',
    '--no-interactive',
  ], process.cwd())

  const workspaceRoot = join(process.cwd(), workspaceName)

  logger.step('Applying MoNecromanCI overlay (release config, .npmrc, commitlint, pipeline, stack)')
  applyOverlay(workspaceRoot, { scope, registry, agent, variableGroup, ci, stack })

  // Install the commit toolchain (and, for the oxlint stack, oxc-standard —
  // which brings oxlint + oxfmt and the JavaScript Standard Style preset the
  // generated oxlint.config.mts / oxfmt.config.mts reference; ESLint is set up
  // by the Nx generators on first `add`). One install.
  const stackDependencies = stack.linter === 'oxlint' ? ['oxc-standard'] : []
  logger.step(`Installing the toolchain (${stack.linter === 'oxlint' ? 'oxc-standard' : 'eslint'}, commit toolchain)`)
  const installStatus = runShell('npm', ['install', '--save-dev', ...stackDependencies, 'husky', '@commitlint/cli', '@commitlint/config-conventional'], workspaceRoot)
  if (installStatus !== 0) {
    throw new Error(`npm install of the toolchain failed with exit code ${installStatus}`)
  }
  // The overlay already stamped `prepare: husky` into the root scripts.
  runShell('npx', ['husky'], workspaceRoot)

  logger.success('Done. Next steps:')
  logger.info(`  cd ${workspaceName}`)
  logger.info('  mnci2 add react-app web        # or: node-app, node-function-app, npm-lib, internal-lib,')
  logger.info('                                 #     python-app, python-function-app, python-lib, python-internal-lib')
  logger.info('  git add -A && git commit -m "feat: initial workspace"')
}
