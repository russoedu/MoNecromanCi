import { isManagedRepo } from '../engine/config'
import { syncGuide } from '../engine/guide'
import { runShell } from '../util/exec'
import { logger } from '../util/logger'

/**
 * Previews the next automated release without changing anything.
 *
 * @remarks
 * Fetches tags first: `nx release version` resolves each project's current
 * version from its last matching git tag, and a local clone that hasn't
 * fetched a tag a previous CI run just pushed would otherwise fall back to
 * whatever `version` is on disk, previewing the wrong bump. Delegates the
 * actual computation to `nx release version --dry-run`, so the preview always
 * matches what CI would do on the next push.
 *
 * @param None - this function takes no parameters.
 * @returns A promise that resolves once the dry run has completed. The child's
 * exit status is propagated through `process.exitCode`.
 * @throws Never - the child exit status is surfaced via `process.exitCode`, not a throw.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runRelease (): Promise<void> {
  const repoRoot = process.cwd()

  if (!isManagedRepo(repoRoot)) {
    logger.error('No .monecromanci.json found here. Run `release` from a MoNecromanCI monorepo root.')
    return
  }

  syncGuide(repoRoot)

  const fetchStatus = runShell('git', ['fetch', '--all', '--prune', '--tags'], repoRoot)
  if (fetchStatus !== 0) {
    logger.warn('Could not fetch tags — the preview may be stale if a release landed from another machine.')
  }

  logger.info('Previewing the next release (nx release version --dry-run)...')
  const status = runShell('npx', ['nx', 'release', 'version', '--dry-run'], repoRoot)

  if (status === 0) {
    logger.success('Preview complete — no changes were made.')
    return
  }

  logger.error(`Release preview failed (exit ${status}).`)
  process.exitCode = status
}
