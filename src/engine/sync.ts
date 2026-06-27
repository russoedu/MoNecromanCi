import { join } from 'node:path'
import { fileExists, readTextSafe, writeFileEnsured } from './fsx'
import type { FileSpec } from './types'

export type FileStatus = 'ok' | 'missing' | 'drift'

/** Compares a tool-owned file on disk against its expected content. */
export function checkFile (repoRoot: string, spec: FileSpec): FileStatus {
  const absolute = join(repoRoot, spec.path)
  if (!fileExists(absolute)) {
    return 'missing'
  }

  return readTextSafe(absolute) === spec.content ? 'ok' : 'drift'
}

export interface SyncReport {
  ok: string[]
  missing: string[]
  drift: string[]
  fixed: string[]
}

/**
 * Checks every `tool-owned` spec against the repo and, when `apply` is set,
 * rewrites the ones that are missing or have drifted. `scaffold` files are
 * never touched, so user edits survive.
 */
export function syncToolOwned (repoRoot: string, specs: FileSpec[], apply: boolean): SyncReport {
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

    if (apply) {
      writeFileEnsured(join(repoRoot, spec.path), spec.content)
      report.fixed.push(spec.path)
    }
  }

  return report
}
