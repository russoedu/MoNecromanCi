import { join } from 'node:path'
import { readAsset } from './assets'
import { writeFileEnsured } from './fsx'

/**
 * The guide's file name at the managed repo's root.
 *
 * @remarks
 * Also the name of the packaged asset the content is read from.
 */
export const GUIDE_FILE = 'MoNecromanCi.md'

/**
 * Writes (or refreshes) the `MoNecromanCi.md` guide at the repo root.
 *
 * @remarks
 * The guide is tool-owned documentation describing the tool, its philosophy,
 * the commit-message-driven release flow and the generated repo's structure.
 * Every command calls this (directly, or via the monorepo file set that
 * includes the same asset) so the copy in a managed repo always matches the
 * installed tool version.
 *
 * @param repoRoot - Absolute path to the managed repo's root.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error raised while writing the file, and
 * throws when the packaged assets directory cannot be located.
 * @typeParam None - this function has no generic type parameters.
 */
export function syncGuide (repoRoot: string): void {
  writeFileEnsured(join(repoRoot, GUIDE_FILE), readAsset(GUIDE_FILE))
}
