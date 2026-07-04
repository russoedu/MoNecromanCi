import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../engine/config'
import type { MonecromanciConfig } from '../engine/types'

jest.mock('../engine/changes', () => ({ changedProjects: jest.fn() }))
jest.mock('../engine/breaking', () => ({ breakingHints: jest.fn() }))

import { breakingHints } from '../engine/breaking'
import { changedProjects } from '../engine/changes'
import { runSpell } from './spell'

const mockChangedProjects = jest.mocked(changedProjects)
const mockBreakingHints = jest.mocked(breakingHints)

const config: MonecromanciConfig = {
  templateVersion: '0.2.0',
  workspaceName:   'demo',
  displayName:     'Demo',
  scope:           '@demo',
  defaultBase:     'main',
  nodeVersion:     '24',
  ci:              'github',
  registry:        { kind: 'npm' },
}

let repoRoot: string
let logSpy: jest.SpyInstance
let errorSpy: jest.SpyInstance

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'monecromanci-spell-'))
  jest.spyOn(process, 'cwd').mockReturnValue(repoRoot)
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  mockBreakingHints.mockReturnValue({})
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
  mockChangedProjects.mockReset()
})

describe('runSpell', () => {
  it('errors when the directory is not a MoNecromanCI repo', async () => {
    await runSpell()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No .monecromanci.json found'))
    expect(mockChangedProjects).not.toHaveBeenCalled()
  })

  it('reports a calm aether when nothing changed', async () => {
    saveConfig(repoRoot, config)
    mockChangedProjects.mockReturnValue([])

    await runSpell()

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no uncommitted changes'))
  })

  it('lists changed projects with their files and suggests the commit scope', async () => {
    saveConfig(repoRoot, config)
    mockChangedProjects.mockReturnValue([
      { name: 'jato.index', path: 'libs/jato.index', files: ['libs/jato.index/src/index.ts'] },
      { name: 'web', path: 'apps/web', files: ['apps/web/src/main.tsx'] },
      { name: 'root', files: ['README.md'] },
    ])

    await runSpell()

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('jato.index (libs/jato.index) — 1 file(s)'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('libs/jato.index/src/index.ts'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Suggested scope: jato.index,web,root'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('feat(jato.index,web,root):'))
  })

  it('prints breaking-change hints and suggests the ! marker when any are found', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    saveConfig(repoRoot, config)
    mockChangedProjects.mockReturnValue([
      { name: 'jato.index', path: 'libs/jato.index', files: ['libs/jato.index/src/index.ts'] },
    ])
    mockBreakingHints.mockReturnValue({
      'jato.index': ['export removed in libs/jato.index/src/index.ts: function greet'],
    })

    await runSpell()

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('possible breaking change — export removed'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('feat(jato.index)!:'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Hints are advisory'))
  })
})
