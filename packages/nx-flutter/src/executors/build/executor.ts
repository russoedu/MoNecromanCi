import { join } from 'node:path'
import type { ExecutorContext } from '@nx/devkit'
import { projectRootFrom } from '../../internal/executorContext'
import { runFlutter } from '../../internal/runFlutter'
import type { BuildExecutorSchema } from './schema.d'

/**
 * Builds a Flutter web bundle into the workspace-root `dist/` tree.
 *
 * @remarks
 * `outputPath` is given workspace-relative (e.g. `dist/apps/web`) because that
 * is the coordinate system the target's Nx `outputs` entry uses, and it is
 * resolved to an **absolute** path before being handed to flutter.
 *
 * **Absolute is a correctness requirement, not a preference, and a relative
 * path is what broke this for real.** A relative `--output` is passed through
 * to `impellerc`, the shader compiler flutter spawns as a subprocess — which
 * does not run with the cwd this executor sets. Two processes then resolve the
 * same relative string against different directories, the Dart bundle compiles
 * fine, and asset copying dies:
 *
 * ```
 * impellerc failure: Could not write file to "..\..\dist\apps\hello\assets\shaders/ink_sparkle.frag"
 * Target web_release_bundle failed: ShaderCompilerException
 * ```
 *
 * Upstream has this open as flutter/flutter#148542 and #157886, present since
 * 3.22/3.23, and every report shares the one condition — a relative `--output`.
 * An absolute path removes cwd from the resolution entirely, so the two
 * processes cannot disagree.
 *
 * The comment this replaces claimed the relative form was "verified end-to-end".
 * It was not: `flutter build web` had never once run in CI — the e2e reported
 * `⊘ SKIPPED the entire Flutter section` until the SDK was provisioned, and then
 * failed at `flutter create` until the CRLF fix. Nothing had ever reached this
 * line.
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
  const outputPath = join(context.root, options.outputPath)

  const result = runFlutter(['build', 'web', '--output', outputPath], cwd)
  if (!result.ok) console.error(`flutter build web ${result.reason}`)

  return { success: result.ok }
}
