import { join } from 'node:path'
import { runNpx, runShell } from '../nx'
import { applyOverlay, type RegistryConfig } from '../overlay'
import { promptRegistry, promptText } from '../prompts'
import { logger } from '../util/logger'

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
  const scope = options.scope ?? (options.yes ? `@${workspaceName}` : await promptText('npm scope for publishable packages', `@${workspaceName}`))
  const registry = await resolveRegistry(options)

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

  logger.step('Applying MoNecromanCI overlay (release config, .npmrc, commitlint, pipeline)')
  applyOverlay(workspaceRoot, { scope, registry })

  logger.step('Installing conventional-commit toolchain (husky + commitlint)')
  const installStatus = runShell('npm', ['install', '--save-dev', 'husky', '@commitlint/cli', '@commitlint/config-conventional'], workspaceRoot)
  if (installStatus !== 0) {
    throw new Error(`npm install of the commit toolchain failed with exit code ${installStatus}`)
  }
  runShell('npm', ['pkg', 'set', 'scripts.prepare=husky'], workspaceRoot)
  runShell('npx', ['husky'], workspaceRoot)

  logger.success('Done. Next steps:')
  logger.info(`  cd ${workspaceName}`)
  logger.info('  mnci2 add react-app web        # or: function-app, npm-lib, internal-lib')
  logger.info('  git add -A && git commit -m "feat: initial workspace"')
}
