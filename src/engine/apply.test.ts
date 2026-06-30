import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyFiles, reportApply } from './apply'
import type { FileSpec } from './types'

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'monecromanci-apply-'))
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8')

describe('applyFiles', () => {
  it('creates a tool-owned file that does not yet exist', () => {
    const files: FileSpec[] = [{ path: 'a.txt', content: 'A', ownership: 'tool-owned' }]
    expect(applyFiles(repoRoot, files)).toEqual({ created: ['a.txt'], overwritten: [], skipped: [] })
    expect(read('a.txt')).toBe('A')
  })

  it('overwrites a tool-owned file that already exists', () => {
    applyFiles(repoRoot, [{ path: 'a.txt', content: 'A', ownership: 'tool-owned' }])
    const result = applyFiles(repoRoot, [{ path: 'a.txt', content: 'B', ownership: 'tool-owned' }])
    expect(result).toEqual({ created: [], overwritten: ['a.txt'], skipped: [] })
    expect(read('a.txt')).toBe('B')
  })

  it('creates a scaffold file that does not yet exist', () => {
    const result = applyFiles(repoRoot, [{ path: 'b.txt', content: 'X', ownership: 'scaffold' }])
    expect(result).toEqual({ created: ['b.txt'], overwritten: [], skipped: [] })
  })

  it('skips a scaffold file that already exists, preserving user edits', () => {
    applyFiles(repoRoot, [{ path: 'b.txt', content: 'X', ownership: 'scaffold' }])
    const result = applyFiles(repoRoot, [{ path: 'b.txt', content: 'Y', ownership: 'scaffold' }])
    expect(result).toEqual({ created: [], overwritten: [], skipped: ['b.txt'] })
    expect(read('b.txt')).toBe('X')
  })
})

describe('reportApply', () => {
  it('logs created, overwritten and skipped paths', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    reportApply({ created: ['new.txt'], overwritten: ['updated.txt'], skipped: ['kept.txt'] })
    expect(logSpy).toHaveBeenCalledWith('✓ created new.txt')
    expect(logSpy).toHaveBeenCalledWith('→ updated updated.txt')
    expect(logSpy).toHaveBeenCalledWith('  kept    kept.txt (already exists)')
    logSpy.mockRestore()
  })
})
