import type { ExecutorContext } from '@nx/devkit'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { projectRootFrom } from '../../internal/executor-context.mapper'
import { pythonCommand } from '../../internal/python-command.algorithm'
import type { TypecheckExecutorSchema } from './schema.d'

/**
 * Runs `<python> -m mypy .` in the project's own directory.
 *
 * @remarks
 * `-m mypy` (not a bare `mypy`) so it resolves whatever Python the caller has
 * active — no hard-coded venv path, matching every other executor in this
 * package. The Python binary itself is resolved by {@link pythonCommand}
 * (`python3` on POSIX, `python` on Windows), not hard-coded.
 *
 * The strictness lives in the project's own `pyproject.toml` under
 * `[tool.mypy]`, beside `[tool.pytest.ini_options]`, rather than in flags
 * here. Two reasons: a user who wants to relax one rule for one project edits
 * the file they already own instead of an Nx target, and `python -m mypy .`
 * run by hand from the project directory then behaves identically to the
 * target — a flag-driven target is how "it passes in CI but not for me"
 * starts.
 *
 * @param _options - Unused (the configuration lives in `pyproject.toml`).
 * @param context - The Nx executor context.
 * @returns `{ success: true }` when mypy exits 0.
 * @throws Never - failures surface through the returned `success: false`.
 * @typeParam None - this function has no generic type parameters.
 */
export default async function typecheckExecutor (
  _options: TypecheckExecutorSchema,
  context: ExecutorContext,
): Promise<{ success: boolean }> {
  const cwd = join(context.root, projectRootFrom(context))
  const result = spawnSync(pythonCommand(), ['-m', 'mypy', '.'], { cwd, stdio: 'inherit' })

  return { success: result.status === 0 }
}
