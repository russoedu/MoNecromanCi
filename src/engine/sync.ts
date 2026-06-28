import { join } from 'node:path'
import { fileExists, readTextSafe, writeFileEnsured } from './fsx'
import type { FileSpec } from './types'

/**
 * Outcome of comparing a tool-owned file on disk against its expected content.
 *
 * @remarks
 * Returned by {@link checkFile} and aggregated into a {@link SyncReport}.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type FileStatus = 'ok' | 'missing' | 'drift'

/**
 * Compares a tool-owned file on disk against its expected content.
 *
 * @remarks
 * Returns `'missing'` rather than `'drift'` when the file does not exist.
 *
 * @param repoRoot - Absolute path to the repo root.
 * @param spec - The file spec to compare against disk.
 * @returns Whether the file is in sync, missing, or has drifted.
 * @throws Never - delegates to {@link readTextSafe}, which swallows read errors.
 * @typeParam None - this function has no generic type parameters.
 */
export function checkFile (repoRoot: string, spec: FileSpec): FileStatus {
  const absolute = join(repoRoot, spec.path)
  if (!fileExists(absolute)) {
    return 'missing'
  }

  return readTextSafe(absolute) === spec.content ? 'ok' : 'drift'
}

/**
 * Outcome of a {@link syncToolOwned} pass.
 *
 * @remarks
 * `fixed` is always a subset of `missing` plus `drift`.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface SyncReport {
  ok:      string[]
  missing: string[]
  drift:   string[]
  fixed:   string[]
}

/**
 * Checks every `tool-owned` spec against the repo and, when `apply` is set,
 * rewrites the ones that are missing or have drifted. `scaffold` files are
 * never touched, so user edits survive.
 *
 * @remarks
 * Used by both `doctor` (report-only by default) and `update` (always applies).
 *
 * @param repoRoot - Absolute path to the repo root.
 * @param specs - The file specs to check (only `tool-owned` ones are inspected).
 * @param shouldApply - Whether to rewrite missing/drifted files.
 * @returns A report of which files are ok, missing, drifted, or were fixed.
 * @throws Propagates any Node.js `fs` error raised while rewriting a file when
 * `shouldApply` is set.
 * @typeParam None - this function has no generic type parameters.
 */
export function syncToolOwned (repoRoot: string, specs: FileSpec[], shouldApply: boolean): SyncReport {
  const report: SyncReport = { ok: [], missing: [], drift: [], fixed: [] }

  for (const spec of specs) {
    if (spec.ownership !== 'tool-owned') {
      continue
    }

    const status = checkFile(repoRoot, spec)
    if (status === 'ok') {
      report.ok.push(spec.path)
      continue
    }

    if (status === 'missing') {
      report.missing.push(spec.path)
    } else {
      report.drift.push(spec.path)
    }

    if (shouldApply) {
      writeFileEnsured(join(repoRoot, spec.path), spec.content)
      report.fixed.push(spec.path)
    }
  }

  return report
}
