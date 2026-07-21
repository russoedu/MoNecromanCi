import type { ExecutorContext } from '@nx/devkit'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { projectRootFrom } from '../../internal/executorContext'
import type { LintExecutorSchema } from './schema.d'

/**
 * Runs `python3 -m ruff check .` in the project's own directory.
 *
 * @remarks
 * `python3 -m ruff` (not a bare `ruff`) so it resolves whatever `python3`
 * the caller has active — no hard-coded venv path, matching every other
 * executor in this package.
 *
 * @param _options - Unused (ruff needs no per-project configuration here).
 * @param context - The Nx executor context.
 * @returns `{ success: true }` when ruff exits 0.
 * @throws Never - failures surface through the returned `success: false`.
 * @typeParam None - this function has no generic type parameters.
 */
export default async function lintExecutor (_options: LintExecutorSchema, context: ExecutorContext): Promise<{ success: boolean }> {
  const cwd = join(context.root, projectRootFrom(context))
  const result = spawnSync('python3', ['-m', 'ruff', 'check', '.'], { cwd, stdio: 'inherit' })
  return { success: result.status === 0 }
}
