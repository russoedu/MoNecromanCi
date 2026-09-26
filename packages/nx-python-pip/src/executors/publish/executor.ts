import type { ExecutorContext } from '@nx/devkit'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { projectRootFrom } from '../../internal/executor-context.mapper'
import { pythonCommand } from '../../internal/python-command.algorithm'
import type { PublishExecutorSchema } from './schema.d'

/**
 * Runs `python -m twine upload --skip-existing dist/*`, for a project this
 * release actually versioned.
 *
 * @remarks
 * **A project with no new version is skipped**, which `@nx/js:release-publish`
 * does too and which is load-bearing rather than tidy. `nx release` is tag-only
 * (`release.git.commit: false`), so an untouched project's `pyproject.toml`
 * holds its scaffold version for ever — publishing it on every release of its
 * neighbours therefore uploads `0.0.1`, repeatedly, and `--skip-existing` turns
 * that into a warning and exit 0, so it is invisible. Worse on a package whose
 * PyPI project does not exist yet: the redundant upload CREATES it at the
 * scaffold version, and each one spends a slot in PyPI's new-project rate
 * limit, which is how a workspace adding several Python packages gets a
 * `429 Too Many Requests` on the one release it meant to publish.
 *
 * `--skip-existing` still mirrors npm's own idempotent-publish behaviour, so a
 * re-run after a partial release failure does not hard-error on the packages
 * that already made it. Credentials
 * (`TWINE_USERNAME`/`TWINE_PASSWORD`/`TWINE_REPOSITORY_URL`) are read from the
 * environment by twine itself — never written to disk here.
 *
 * `dryRun` is a real, typed executor option (unlike a plain
 * `nx:run-commands` target, which would only see the `--dry-run` flag as an
 * opaque, appended `--dryRun=true` string on the shell command line).
 * `nx release publish` sets `dryRun` automatically for every
 * `nx-release-publish` executor, custom or not, so no argv-parsing trick is
 * needed to preview instead of uploading for real. It is checked *after* the
 * version data, so a dry run reports the same skip a real run would make.
 *
 * @param options - Whether to preview instead of uploading, and what the
 * version step resolved for each project.
 * @param context - The Nx executor context.
 * @returns `{ success: true }` on a successful (real, previewed or skipped) publish.
 * @throws Never - failures surface through the returned `success: false`.
 * @typeParam None - this function has no generic type parameters.
 */
export default async function publishExecutor (
  options: PublishExecutorSchema,
  context: ExecutorContext,
): Promise<{ success: boolean }> {
  const versionData = context.projectName === undefined
    ? undefined
    : options.nxReleaseVersionData?.[context.projectName]

  if (versionData?.newVersion === null) {
    console.log(`Skipped project "${context.projectName}", because no new version was resolved for this project`)

    return { success: true }
  }

  if (options.dryRun) {
    console.log(`[dry-run] would run: ${pythonCommand()} -m twine upload --skip-existing dist/*`)

    return { success: true }
  }

  const cwd = join(context.root, projectRootFrom(context))
  // No shell: true needed for the dist/* glob — twine globs its own path
  // arguments internally, so this stays free of a shell-injection surface.
  const result = spawnSync(
    pythonCommand(),
    ['-m', 'twine', 'upload', '--skip-existing', 'dist/*'],
    { cwd, stdio: 'inherit' },
  )

  return { success: result.status === 0 }
}
