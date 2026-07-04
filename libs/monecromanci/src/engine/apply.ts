import { join } from 'node:path'
import { fileExists, writeFileEnsured } from './fsx'
import { logger } from '../util/logger'
import type { FileSpec } from './types'

/**
 * Outcome of writing a batch of {@link FileSpec}s to disk.
 *
 * @remarks
 * Returned by {@link applyFiles} and consumed by {@link reportApply}.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface ApplyResult {
  created:     string[]
  overwritten: string[]
  skipped:     string[]
}

/**
 * Writes a set of {@link FileSpec}s into `repoRoot`.
 *
 * @remarks
 * `tool-owned` files are always written; `scaffold` files are only written when
 * they do not yet exist, so user edits are preserved on re-runs.
 *
 * @param repoRoot - Absolute path to the target repo root.
 * @param files - The file specs to write.
 * @returns Which paths were created, overwritten, or skipped.
 * @throws Propagates any Node.js `fs` error (e.g. permission denied) raised
 * while writing a file.
 * @typeParam None - this function has no generic type parameters.
 */
export function applyFiles (repoRoot: string, files: FileSpec[]): ApplyResult {
  const result: ApplyResult = { created: [], overwritten: [], skipped: [] }

  for (const file of files) {
    const absolute = join(repoRoot, file.path)
    const exists = fileExists(absolute)

    if (file.ownership === 'scaffold' && exists) {
      result.skipped.push(file.path)
      continue
    }

    writeFileEnsured(absolute, file.content)
    if (exists) {
      result.overwritten.push(file.path)
    } else {
      result.created.push(file.path)
    }
  }

  return result
}

/**
 * Logs a concise summary of an {@link ApplyResult}.
 *
 * @remarks
 * Purely a logging side effect; does not touch the filesystem.
 *
 * @param result - The result to summarise.
 * @returns Nothing.
 * @throws Never - only writes to the logger.
 * @typeParam None - this function has no generic type parameters.
 */
export function reportApply (result: ApplyResult): void {
  for (const path of result.created) {
    logger.success(`created ${path}`)
  }
  for (const path of result.overwritten) {
    logger.step(`updated ${path}`)
  }
  for (const path of result.skipped) {
    logger.info(`  kept    ${path} (already exists)`)
  }
}
