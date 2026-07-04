import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSpellbook } from './spellbook'

let repoRoot: string
let logSpy: jest.SpyInstance

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'monecromanci-spellbook-'))
  jest.spyOn(process, 'cwd').mockReturnValue(repoRoot)
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

describe('runSpellbook', () => {
  it('writes MoNecromanCi.md at the repo root, even without a stamp', async () => {
    await runSpellbook()

    expect(existsSync(join(repoRoot, 'MoNecromanCi.md'))).toBe(true)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('MoNecromanCi.md written'))
  })
})
