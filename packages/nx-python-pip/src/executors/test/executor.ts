import type { ExecutorContext } from '@nx/devkit'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { projectRootFrom } from '../../internal/executorContext'
import type { TestExecutorSchema } from './schema.d'

/**
 * Runs pytest for a Python project, optionally installing it in editable
 * mode first so its own declared dependencies are importable.
 *
 * @remarks
 * `pip install -e .` (when `installEditable` is not `false`) makes the
 * project's `pyproject.toml` `dependencies` (real external PyPI packages)
 * importable at test time. It does **not** make vendored internal-lib
 * imports importable — those are woven in only at `build` time (see the
 * `build` executor's remarks) — so a project whose pytest-covered code
 * imports a vendored internal lib needs its own test isolation strategy;
 * this executor makes no attempt to solve that.
 *
 * @param options - Whether to `pip install -e .` before pytest.
 * @param context - The Nx executor context.
 * @returns `{ success: true }` when pytest exits 0 (and, when requested, the
 * editable install also succeeded).
 * @throws Never - failures surface through the returned `success: false`.
 * @typeParam None - this function has no generic type parameters.
 */
export default async function testExecutor (options: TestExecutorSchema, context: ExecutorContext): Promise<{ success: boolean }> {
  const cwd = join(context.root, projectRootFrom(context))

  if (options.installEditable !== false) {
    const install = spawnSync('python3', ['-m', 'pip', 'install', '--quiet', '-e', '.'], { cwd, stdio: 'inherit' })
    if (install.status !== 0) {
      return { success: false }
    }
  }

  const result = spawnSync('python3', ['-m', 'pytest'], { cwd, stdio: 'inherit' })
  return { success: result.status === 0 }
}
