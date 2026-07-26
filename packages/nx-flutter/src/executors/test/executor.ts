import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { ExecutorContext } from '@nx/devkit'
import { projectRootFrom } from '../../internal/executorContext'
import { flutterCommand } from '../../internal/flutterCommand'
import type { TestExecutorSchema } from './schema.d'

/**
 * Runs `flutter test` in the project's own directory.
 *
 * @remarks
 * No dependency-install step of its own, unlike this plugin's Python
 * counterpart: pub workspace members share one root `.dart_tool/`
 * package config, so a single `flutter pub get` at the workspace root (which
 * CI runs once) already makes every internal and external dependency
 * resolvable from every project. There is nothing per-project left to wire.
 *
 * A package with no `test/` directory exits non-zero on some SDK versions;
 * mnci's generators always scaffold one, so that case does not arise for
 * generated projects.
 *
 * @param _options - Unused (the SDK discovers `test/` itself).
 * @param context - The Nx executor context.
 * @returns `{ success: true }` when the test run exits 0.
 * @throws Never - failures surface through the returned `success: false`.
 * @typeParam None - this function has no generic type parameters.
 */
export default async function testExecutor(
  _options: TestExecutorSchema,
  context: ExecutorContext
): Promise<{ success: boolean }> {
  const cwd = join(context.root, projectRootFrom(context))
  const result = spawnSync(flutterCommand(), ['test'], { cwd, stdio: 'inherit' })
  return { success: result.status === 0 }
}
