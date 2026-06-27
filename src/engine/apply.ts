import { join } from 'node:path'
import { fileExists, writeFileEnsured } from './fsx'
import { logger } from '../util/logger'
import type { FileSpec } from './types'

export interface ApplyResult {
  created: string[]
  overwritten: string[]
  skipped: string[]
}

/**
 * Writes a set of {@link FileSpec}s into `repoRoot`.
 *
 * `tool-owned` files are always written; `scaffold` files are only written when
 * they do not yet exist, so user edits are preserved on re-runs.
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

/** Logs a concise summary of an {@link ApplyResult}. */
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
