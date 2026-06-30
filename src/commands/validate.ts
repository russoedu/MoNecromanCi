import { isManagedRepo } from '../engine/config'
import { runShell } from '../util/exec'
import { logger } from '../util/logger'

/**
 * Options accepted by {@link runValidate}.
 *
 * @remarks
 * Mirrors the CLI's `--all` flag.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface ValidateOptions {
  all: boolean
}

/**
 * Runs lint/test/build locally so failures surface before reaching CI.
 *
 * @remarks
 * Delegates to the repo's own Nx: `nx affected` by default (only projects touched
 * since the base branch) or `nx run-many` with `--all`. Targets a project does not
 * define are skipped by Nx, so mixed project kinds are safe. The child's exit
 * status is propagated through `process.exitCode`.
 *
 * @param options - Whether to validate every project (`all: true`) or only affected.
 * @returns A promise that resolves once the Nx run has completed.
 * @throws Never - the child exit status is surfaced via `process.exitCode`, not a throw.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runValidate (options: ValidateOptions): Promise<void> {
  const repoRoot = process.cwd()

  if (!isManagedRepo(repoRoot)) {
    logger.error('No .monecromanci.json found here. Run `validate` from a MoNecromanCI monorepo root.')
    return
  }

  const arguments_ = ['nx', options.all ? 'run-many' : 'affected', '-t', 'lint', 'test', 'build']

  logger.info(`Running: npx ${arguments_.join(' ')}`)
  const status = runShell('npx', arguments_, repoRoot)

  if (status === 0) {
    logger.success('Validation passed.')
    return
  }

  logger.error(`Validation failed (exit ${status}).`)
  process.exitCode = status
}
