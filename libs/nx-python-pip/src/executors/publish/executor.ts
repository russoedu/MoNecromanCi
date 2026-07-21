import type { ExecutorContext } from '@nx/devkit'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { projectRootFrom } from '../../internal/executorContext'
import type { PublishExecutorSchema } from './schema.d'

/**
 * Runs `python -m twine upload --skip-existing dist/*`.
 *
 * @remarks
 * `--skip-existing` mirrors npm's own idempotent-publish behaviour (Nx's
 * `@nx/js:release-publish` also tolerates a version already on the
 * registry), so a re-run after a partial release failure does not
 * hard-error on the packages that already made it. Credentials
 * (`TWINE_USERNAME`/`TWINE_PASSWORD`/`TWINE_REPOSITORY_URL`) are read from
 * the environment by twine itself — never written to disk here.
 *
 * `dryRun` is a real, typed executor option (unlike a plain
 * `nx:run-commands` target, which would only see the `--dry-run` flag as an
 * opaque, appended `--dryRun=true` string on the shell command line).
 * `nx release publish` sets `dryRun` automatically for every
 * `nx-release-publish` executor, custom or not, so no argv-parsing trick is
 * needed to preview instead of uploading for real.
 *
 * @param options - Whether to preview instead of actually uploading.
 * @param context - The Nx executor context.
 * @returns `{ success: true }` on a successful (real or previewed) publish.
 * @throws Never - failures surface through the returned `success: false`.
 * @typeParam None - this function has no generic type parameters.
 */
export default async function publishExecutor (options: PublishExecutorSchema, context: ExecutorContext): Promise<{ success: boolean }> {
  if (options.dryRun) {
    console.log('[dry-run] would run: python3 -m twine upload --skip-existing dist/*')
    return { success: true }
  }

  const cwd = join(context.root, projectRootFrom(context))
  // No shell: true needed for the dist/* glob — twine globs its own path
  // arguments internally, so this stays free of a shell-injection surface.
  const result = spawnSync('python3', ['-m', 'twine', 'upload', '--skip-existing', 'dist/*'], { cwd, stdio: 'inherit' })
  return { success: result.status === 0 }
}
