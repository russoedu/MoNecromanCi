import { spawnSync } from 'node:child_process'
import { join, relative } from 'node:path'
import type { ExecutorContext } from '@nx/devkit'
import { projectRootFrom } from '../../internal/executorContext'
import { flutterCommand } from '../../internal/flutterCommand'
import type { BuildExecutorSchema } from './schema.d'

/**
 * Builds a Flutter web bundle into the workspace-root `dist/` tree.
 *
 * @remarks
 * `outputPath` is given workspace-relative (e.g. `dist/apps/web`) because
 * that is the coordinate system the target's Nx `outputs` entry uses, but
 * `flutter build web --output` resolves its argument against the **process
 * cwd** — which here is the project directory, not the workspace root. So the
 * path is converted with `relative()` rather than passed through, which also
 * keeps it correct on Windows (where a hand-built `../../` string would mix
 * separators). Verified end-to-end: building from the project directory with
 * the relative form lands the bundle at the workspace-root path the `outputs`
 * entry declares.
 *
 * The result is a **directory** containing `index.html` and the compiled
 * bundle. That matters beyond tidiness: Nx scans each declared output to
 * cache it, and scanning a bare file raises `ENOTDIR` — the trap `add/go.ts`
 * documents for `go build`, which `flutter build web` avoids natively.
 *
 * @param options - The workspace-relative output path.
 * @param context - The Nx executor context.
 * @returns `{ success: true }` when the build exits 0.
 * @throws Never - failures surface through the returned `success: false`.
 * @typeParam None - this function has no generic type parameters.
 */
export default async function buildExecutor(
  options: BuildExecutorSchema,
  context: ExecutorContext
): Promise<{ success: boolean }> {
  const projectRoot = projectRootFrom(context)
  const cwd = join(context.root, projectRoot)
  const outputPath = relative(cwd, join(context.root, options.outputPath))

  const result = spawnSync(flutterCommand(), ['build', 'web', '--output', outputPath], {
    cwd,
    stdio: 'inherit'
  })
  return { success: result.status === 0 }
}
