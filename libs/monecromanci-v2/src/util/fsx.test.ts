import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replaceInFile } from './fsx'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mnci2-fsx-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('replaceInFile', () => {
  it('replaces the first match in place', () => {
    const path = join(directory, 'config.txt')
    writeFileSync(path, 'outputPath: \'./dist\',\nother: 1,\n')

    replaceInFile(path, /outputPath: '\.\/dist'/, 'outputPath: \'../../dist/packages/sdk\'')

    expect(readFileSync(path, 'utf8')).toBe('outputPath: \'../../dist/packages/sdk\',\nother: 1,\n')
  })

  it('throws instead of silently no-op-ing when the pattern is not found', () => {
    const path = join(directory, 'config.txt')
    writeFileSync(path, 'nothing to see here\n')

    expect(() => replaceInFile(path, /outputPath: '\.\/dist'/, 'replacement')).toThrow('not found')
  })
})
