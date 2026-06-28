import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkFile, syncToolOwned } from './sync'
import type { FileSpec } from './types'

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'nx-magic-sync-'))
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('checkFile', () => {
  it('is missing when the file does not exist', () => {
    expect(checkFile(repoRoot, { path: 'a.txt', content: 'A', ownership: 'tool-owned' })).toBe('missing')
  })

  it('is ok when the file matches the expected content', () => {
    writeFileSync(join(repoRoot, 'a.txt'), 'A', 'utf8')
    expect(checkFile(repoRoot, { path: 'a.txt', content: 'A', ownership: 'tool-owned' })).toBe('ok')
  })

  it('is drift when the file content differs', () => {
    writeFileSync(join(repoRoot, 'a.txt'), 'OLD', 'utf8')
    expect(checkFile(repoRoot, { path: 'a.txt', content: 'NEW', ownership: 'tool-owned' })).toBe('drift')
  })
})

describe('syncToolOwned', () => {
  it('ignores scaffold specs entirely', () => {
    const specs: FileSpec[] = [{ path: 'scaffold.txt', content: 'X', ownership: 'scaffold' }]
    expect(syncToolOwned(repoRoot, specs, false)).toEqual({ ok: [], missing: [], drift: [], fixed: [] })
  })

  it('reports ok/missing/drift without writing when apply is false', () => {
    writeFileSync(join(repoRoot, 'ok.txt'), 'A', 'utf8')
    writeFileSync(join(repoRoot, 'drift.txt'), 'OLD', 'utf8')
    const specs: FileSpec[] = [
      { path: 'ok.txt', content: 'A', ownership: 'tool-owned' },
      { path: 'missing.txt', content: 'M', ownership: 'tool-owned' },
      { path: 'drift.txt', content: 'NEW', ownership: 'tool-owned' },
    ]
    const report = syncToolOwned(repoRoot, specs, false)
    expect(report).toEqual({ ok: ['ok.txt'], missing: ['missing.txt'], drift: ['drift.txt'], fixed: [] })
    expect(readFileSync(join(repoRoot, 'drift.txt'), 'utf8')).toBe('OLD')
  })

  it('writes fixes for missing and drifted files when apply is true', () => {
    writeFileSync(join(repoRoot, 'drift.txt'), 'OLD', 'utf8')
    const specs: FileSpec[] = [
      { path: 'missing.txt', content: 'M', ownership: 'tool-owned' },
      { path: 'drift.txt', content: 'NEW', ownership: 'tool-owned' },
    ]
    const report = syncToolOwned(repoRoot, specs, true)
    expect(report.fixed).toEqual(['missing.txt', 'drift.txt'])
    expect(readFileSync(join(repoRoot, 'missing.txt'), 'utf8')).toBe('M')
    expect(readFileSync(join(repoRoot, 'drift.txt'), 'utf8')).toBe('NEW')
  })
})
