import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { ExecutorContext } from '@nx/devkit'
import { projectRootFrom } from '../../internal/executorContext'
import { flutterCommand } from '../../internal/flutterCommand'
import type { LintExecutorSchema } from './schema.d'

/**
 * Runs `flutter analyze --fatal-infos` in the project's own directory.
 *
 * @remarks
 * `--fatal-infos` is passed explicitly even though `flutter analyze` already
 * defaults it on (verified against Flutter 3.44.8: `--help` reports
 * "defaults to on", and `--no-fatal-infos` turns a failing lint run green).
 * It is pinned anyway because that default is the *only* thing making this a
 * real lint gate: almost every rule in `flutter_lints` reports at info
 * severity, so were the default ever to flip, this target would keep exiting
 * 0 while silently enforcing nothing.
 *
 * Note the contrast with plain `dart analyze`, whose default is the opposite
 * — it fails on errors and warnings but *not* infos. Anyone swapping this
 * command for `dart analyze` without carrying the flag across would get
 * exactly that silent-pass failure mode.
 *
 * @param _options - Unused (the analyser is configured by analysis_options.yaml).
 * @param context - The Nx executor context.
 * @returns `{ success: true }` when the analyser exits 0.
 * @throws Never - failures surface through the returned `success: false`.
 * @typeParam None - this function has no generic type parameters.
 */
export default async function lintExecutor(
  _options: LintExecutorSchema,
  context: ExecutorContext
): Promise<{ success: boolean }> {
  const cwd = join(context.root, projectRootFrom(context))
  const result = spawnSync(flutterCommand(), ['analyze', '--fatal-infos'], {
    cwd,
    stdio: 'inherit'
  })
  return { success: result.status === 0 }
}
