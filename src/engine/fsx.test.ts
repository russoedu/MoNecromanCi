import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDirectory, fileExists, readJsonSafe, readTextSafe, toJson, writeFileEnsured } from './fsx'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'nx-magic-fsx-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('ensureDirectory', () => {
  it('creates a missing directory, including parents', () => {
    const target = join(directory, 'a', 'b', 'c')
    ensureDirectory(target)
    expect(existsSync(target)).toBe(true)
  })

  it('is a no-op when the directory already exists', () => {
    ensureDirectory(directory)
    expect(existsSync(directory)).toBe(true)
  })
})

describe('writeFileEnsured', () => {
  it('writes the file, creating parent directories as needed', () => {
    const target = join(directory, 'nested', 'file.txt')
    writeFileEnsured(target, 'hello')
    expect(readFileSync(target, 'utf8')).toBe('hello')
  })
})

describe('readJsonSafe', () => {
  it('parses a valid JSON file', () => {
    const target = join(directory, 'data.json')
    writeFileEnsured(target, '{"a":1}')
    expect(readJsonSafe<{ a: number }>(target)).toEqual({ a: 1 })
  })

  it('returns the fallback when the file is missing', () => {
    expect(readJsonSafe(join(directory, 'missing.json'), { fallback: true })).toEqual({ fallback: true })
  })

  it('returns undefined with no fallback when the file is missing', () => {
    expect(readJsonSafe(join(directory, 'missing.json'))).toBeUndefined()
  })
})

describe('readTextSafe', () => {
  it('returns the trimmed text content of a file', () => {
    const target = join(directory, 'note.txt')
    writeFileEnsured(target, 'content')
    expect(readTextSafe(target)).toBe('content')
  })

  it('returns an empty string when the file cannot be read', () => {
    expect(readTextSafe(join(directory, 'missing.txt'))).toBe('')
  })
})

describe('toJson', () => {
  it('pretty-prints with a trailing newline', () => {
    expect(toJson({ a: 1 })).toBe('{\n  "a": 1\n}\n')
  })
})

describe('fileExists', () => {
  it('reports whether a path exists', () => {
    expect(fileExists(directory)).toBe(true)
    expect(fileExists(join(directory, 'missing'))).toBe(false)
  })
})
