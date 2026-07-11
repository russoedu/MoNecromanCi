import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TRIGGER_BRANCHES, TAGS, TEMPLATE_VERSION } from '../engine/constants'
import type { MonecromanciConfig } from '../engine/types'

jest.mock('../engine/sync', () => ({ syncToolOwned: jest.fn() }))
jest.mock('../util/prompts', () => ({
  promptBranchList:  jest.fn(),
  promptDriftChoice: jest.fn(),
  renderDiff:        jest.fn().mockReturnValue('- old\n+ new'),
}))

import * as configModule from '../engine/config'
import { loadConfig, saveConfig } from '../engine/config'
import { syncToolOwned } from '../engine/sync'
import { promptBranchList, promptDriftChoice } from '../util/prompts'
import { runDoctor } from './doctor'

const config: MonecromanciConfig = {
  templateVersion: '0.0.1',
  workspaceName:   'demo',
  displayName:     'Demo',
  scope:           '@demo',
  defaultBase:     'main',
  nodeVersion:     '24',
  ci:              'azure',
  registry:        { kind: 'azure-artifacts', organization: 'org', project: 'proj', artifactsFeed: 'feed' },
  triggerBranches: ['dev', 'main'],
}

const mockSyncToolOwned = jest.mocked(syncToolOwned)
const mockPromptBranchList = jest.mocked(promptBranchList)
const mockPromptDriftChoice = jest.mocked(promptDriftChoice)

let repoRoot: string
let logSpy: jest.SpyInstance
let warnSpy: jest.SpyInstance
let errorSpy: jest.SpyInstance

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'monecromanci-doctor-'))
  jest.spyOn(process, 'cwd').mockReturnValue(repoRoot)
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  // Generated repos always carry this in their scaffold .npmrc.
  writeFileSync(join(repoRoot, '.npmrc'), 'legacy-peer-deps=true\n')
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

describe('runDoctor', () => {
  it('errors when the directory is not a MoNecromanCI repo', async () => {
    await runDoctor({ apply: false })
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No .monecromanci.json found'))
    expect(mockSyncToolOwned).not.toHaveBeenCalled()
  })

  it('errors when the stamp exists but cannot be parsed', async () => {
    saveConfig(repoRoot, config)
    jest.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new Error('bad json')
    })
    await runDoctor({ apply: false })
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Could not read .monecromanci.json'))
  })

  it('reports everything in sync when there are no issues', async () => {
    saveConfig(repoRoot, config)
    const saveConfigSpy = jest.spyOn(configModule, 'saveConfig')
    mockSyncToolOwned.mockReturnValue({ ok: ['a.json'], missing: [], drift: [], fixed: [] })
    await runDoctor({ apply: false })
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Everything is in sync (1 tool-owned files checked)'))
    expect(saveConfigSpy).not.toHaveBeenCalled()
    // The guide travels with every command, even a report-only doctor run.
    expect(existsSync(join(repoRoot, 'MoNecromanCi.md'))).toBe(true)
  })

  it('reports issues without writing fixes when apply is false', async () => {
    saveConfig(repoRoot, config)
    mockSyncToolOwned.mockReturnValue({ ok: [], missing: ['m.json'], drift: ['d.json'], fixed: [] })
    await runDoctor({ apply: false })
    expect(warnSpy).toHaveBeenCalledWith('! missing: m.json')
    expect(warnSpy).toHaveBeenCalledWith('! drift:   d.json')
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Re-run with --fix'))
  })

  it('skips writing a reported-missing path that has no matching spec', async () => {
    saveConfig(repoRoot, config)
    mockSyncToolOwned.mockReturnValue({ ok: [], missing: ['no-such-spec.json'], drift: [], fixed: [] })
    await runDoctor({ apply: true })
    expect(warnSpy).toHaveBeenCalledWith('! missing: no-such-spec.json')
    expect(existsSync(join(repoRoot, 'no-such-spec.json'))).toBe(false)
  })

  it('repairs a missing file and re-stamps the template version when apply is true', async () => {
    saveConfig(repoRoot, config)
    mockSyncToolOwned.mockReturnValue({ ok: [], missing: ['nx.json'], drift: [], fixed: [] })
    await runDoctor({ apply: true })
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('fixed:   nx.json'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`Repaired 1 issue(s); stamped template version ${TEMPLATE_VERSION}`))
    expect(loadConfig(repoRoot)?.templateVersion).toBe(TEMPLATE_VERSION)
    expect(existsSync(join(repoRoot, 'nx.json'))).toBe(true)
  })

  it('calls saveConfig with the spread config and the current template version', async () => {
    saveConfig(repoRoot, config)
    const saveConfigSpy = jest.spyOn(configModule, 'saveConfig')
    mockSyncToolOwned.mockReturnValue({ ok: [], missing: [], drift: ['d.json'], fixed: ['d.json'] })
    await runDoctor({ apply: true })
    expect(saveConfigSpy).toHaveBeenCalledWith(repoRoot, { ...config, templateVersion: TEMPLATE_VERSION })
  })

  it('flags superseded lint packages and a missing legacy-peer-deps as issues', async () => {
    saveConfig(repoRoot, config)
    rmSync(join(repoRoot, '.npmrc'))
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ devDependencies: { 'eslint-config-standard': '^17.1.0' } }))
    mockSyncToolOwned.mockReturnValue({ ok: ['a.json'], missing: [], drift: [], fixed: [] })

    await runDoctor({ apply: false })

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('superseded lint package \'eslint-config-standard\''))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing legacy-peer-deps'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2 issue(s) found'))
    // Report-only: nothing was changed.
    expect(existsSync(join(repoRoot, '.npmrc'))).toBe(false)
  })

  it('removes superseded lint packages and repairs .npmrc with --fix', async () => {
    saveConfig(repoRoot, config)
    rmSync(join(repoRoot, '.npmrc'))
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ devDependencies: { 'eslint-config-standard': '^17.1.0', eslint: '^10.6.0' } }))
    mockSyncToolOwned.mockReturnValue({ ok: ['a.json'], missing: [], drift: [], fixed: [] })

    await runDoctor({ apply: true })

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('removed superseded lint package \'eslint-config-standard\''))
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }
    expect(manifest.devDependencies).toEqual({ eslint: '^10.6.0' })
    expect(readFileSync(join(repoRoot, '.npmrc'), 'utf8')).toContain('legacy-peer-deps=true')
  })

  it('flags an obsolete vendored file (from a prior template version) as an issue without deleting it', async () => {
    saveConfig(repoRoot, config)
    writeFileSync(join(repoRoot, 'tsconfig.base.json'), '{}')
    mockSyncToolOwned.mockReturnValue({ ok: ['a.json'], missing: [], drift: [], fixed: [] })

    await runDoctor({ apply: false })

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('obsolete: tsconfig.base.json'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1 issue(s) found'))
    expect(existsSync(join(repoRoot, 'tsconfig.base.json'))).toBe(true)
  })

  it('deletes an obsolete vendored file with --fix', async () => {
    saveConfig(repoRoot, config)
    writeFileSync(join(repoRoot, 'jest.preset.mjs'), 'export function createConfig () {}')
    mockSyncToolOwned.mockReturnValue({ ok: ['a.json'], missing: [], drift: [], fixed: [] })

    await runDoctor({ apply: true })

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('removed: jest.preset.mjs'))
    expect(existsSync(join(repoRoot, 'jest.preset.mjs'))).toBe(false)
  })

  it('deletes the whole obsolete .build-templates directory tree with --fix', async () => {
    saveConfig(repoRoot, config)
    mkdirSync(join(repoRoot, '.build-templates', 'lib'), { recursive: true })
    writeFileSync(join(repoRoot, '.build-templates', '01-preparation.mjs'), '// old')
    writeFileSync(join(repoRoot, '.build-templates', 'lib', '_h.mjs'), '// old')
    mockSyncToolOwned.mockReturnValue({ ok: ['a.json'], missing: [], drift: [], fixed: [] })

    await runDoctor({ apply: true })

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('removed: .build-templates'))
    expect(existsSync(join(repoRoot, '.build-templates'))).toBe(false)
  })

  it('includes discovered projects specs alongside the monorepo specs', async () => {
    saveConfig(repoRoot, config)
    const libDirectory = join(repoRoot, 'libs', 'helpers')
    mkdirSync(libDirectory, { recursive: true })
    writeFileSync(join(libDirectory, 'project.json'), JSON.stringify({ tags: [TAGS.internalLib] }))
    writeFileSync(join(libDirectory, 'package.json'), JSON.stringify({ name: '@demo/helpers' }))
    mockSyncToolOwned.mockReturnValue({ ok: ['a.json'], missing: [], drift: [], fixed: [] })

    await runDoctor({ apply: false })

    const specs = mockSyncToolOwned.mock.calls[0][1]
    expect(specs.some((spec) => spec.path.includes('helpers'))).toBe(true)
  })

  it('flags missing triggerBranches as an issue without prompting when apply is false', async () => {
    saveConfig(repoRoot, { ...config, triggerBranches: undefined })
    mockSyncToolOwned.mockReturnValue({ ok: ['a.json'], missing: [], drift: [], fixed: [] })

    await runDoctor({ apply: false })

    expect(mockPromptBranchList).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('triggerBranches not set'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1 issue(s) found'))
    expect(loadConfig(repoRoot)?.triggerBranches).toBeUndefined()
  })

  it('prompts for and persists triggerBranches when missing and apply is true', async () => {
    saveConfig(repoRoot, { ...config, triggerBranches: undefined })
    mockSyncToolOwned.mockReturnValue({ ok: ['a.json'], missing: [], drift: [], fixed: [] })
    mockPromptBranchList.mockResolvedValue(['main', 'release'])

    await runDoctor({ apply: true })

    expect(mockPromptBranchList).toHaveBeenCalledWith('Branches that should trigger CI', DEFAULT_TRIGGER_BRANCHES)
    expect(loadConfig(repoRoot)?.triggerBranches).toEqual(['main', 'release'])
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Repaired 1 issue(s)'))
  })

  it('does not prompt for triggerBranches once it is already set', async () => {
    saveConfig(repoRoot, config)
    mockSyncToolOwned.mockReturnValue({ ok: ['a.json'], missing: [], drift: [], fixed: [] })

    await runDoctor({ apply: true })

    expect(mockPromptBranchList).not.toHaveBeenCalled()
  })

  describe('drift resolution', () => {
    // Real drift against a genuine tool-owned file (nx.json), so writes/reads go
    // through the actual on-disk content, not an arbitrary mocked path.
    function writeDriftedNxJson (): void {
      writeFileSync(join(repoRoot, 'nx.json'), '{"stale": true}')
    }

    it('reports drift without prompting when apply is false', async () => {
      saveConfig(repoRoot, config)
      writeDriftedNxJson()
      mockSyncToolOwned.mockReturnValue({ ok: [], missing: [], drift: ['nx.json'], fixed: [] })

      await runDoctor({ apply: false })

      expect(mockPromptDriftChoice).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith('! drift:   nx.json')
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1 issue(s) found'))
      expect(readFileSync(join(repoRoot, 'nx.json'), 'utf8')).toBe('{"stale": true}')
    })

    it('writes the file once and does not persist a preference for "update"', async () => {
      saveConfig(repoRoot, config)
      writeDriftedNxJson()
      mockSyncToolOwned.mockReturnValue({ ok: [], missing: [], drift: ['nx.json'], fixed: [] })
      mockPromptDriftChoice.mockResolvedValue('update')

      await runDoctor({ apply: true })

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('fixed:   nx.json'))
      expect(readFileSync(join(repoRoot, 'nx.json'), 'utf8')).not.toBe('{"stale": true}')
      expect(loadConfig(repoRoot)?.fileSyncPreferences).toBeUndefined()
    })

    it('leaves the file untouched and reports it as still drifted for "skip"', async () => {
      saveConfig(repoRoot, config)
      writeDriftedNxJson()
      mockSyncToolOwned.mockReturnValue({ ok: [], missing: [], drift: ['nx.json'], fixed: [] })
      mockPromptDriftChoice.mockResolvedValue('skip')

      await runDoctor({ apply: true })

      expect(warnSpy).toHaveBeenCalledWith('! drift:   nx.json')
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('left as drift'))
      expect(readFileSync(join(repoRoot, 'nx.json'), 'utf8')).toBe('{"stale": true}')
      expect(loadConfig(repoRoot)?.fileSyncPreferences).toBeUndefined()
    })

    it('writes the file and persists an "always" preference', async () => {
      saveConfig(repoRoot, config)
      writeDriftedNxJson()
      mockSyncToolOwned.mockReturnValue({ ok: [], missing: [], drift: ['nx.json'], fixed: [] })
      mockPromptDriftChoice.mockResolvedValue('always')

      await runDoctor({ apply: true })

      expect(readFileSync(join(repoRoot, 'nx.json'), 'utf8')).not.toBe('{"stale": true}')
      expect(loadConfig(repoRoot)?.fileSyncPreferences).toEqual({ 'nx.json': 'always' })
    })

    it('leaves the file untouched and persists a "never" preference, not counted as an issue', async () => {
      saveConfig(repoRoot, config)
      writeDriftedNxJson()
      mockSyncToolOwned.mockReturnValue({ ok: [], missing: [], drift: ['nx.json'], fixed: [] })
      mockPromptDriftChoice.mockResolvedValue('never')

      await runDoctor({ apply: true })

      expect(readFileSync(join(repoRoot, 'nx.json'), 'utf8')).toBe('{"stale": true}')
      expect(loadConfig(repoRoot)?.fileSyncPreferences).toEqual({ 'nx.json': 'never' })
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Everything is in sync'))
    })

    it('honours an existing "always" preference without prompting when applying', async () => {
      saveConfig(repoRoot, { ...config, fileSyncPreferences: { 'nx.json': 'always' } })
      writeDriftedNxJson()
      mockSyncToolOwned.mockReturnValue({ ok: [], missing: [], drift: ['nx.json'], fixed: [] })

      await runDoctor({ apply: true })

      expect(mockPromptDriftChoice).not.toHaveBeenCalled()
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('fixed:   nx.json'))
      expect(readFileSync(join(repoRoot, 'nx.json'), 'utf8')).not.toBe('{"stale": true}')
    })

    it('never writes for an existing "always" preference during a report-only run', async () => {
      saveConfig(repoRoot, { ...config, fileSyncPreferences: { 'nx.json': 'always' } })
      writeDriftedNxJson()
      mockSyncToolOwned.mockReturnValue({ ok: [], missing: [], drift: ['nx.json'], fixed: [] })

      await runDoctor({ apply: false })

      expect(mockPromptDriftChoice).not.toHaveBeenCalled()
      expect(readFileSync(join(repoRoot, 'nx.json'), 'utf8')).toBe('{"stale": true}')
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('re-run with --fix to apply'))
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Everything is in sync'))
    })

    it('honours an existing "never" preference without prompting, in either mode', async () => {
      saveConfig(repoRoot, { ...config, fileSyncPreferences: { 'nx.json': 'never' } })
      writeDriftedNxJson()
      mockSyncToolOwned.mockReturnValue({ ok: [], missing: [], drift: ['nx.json'], fixed: [] })

      await runDoctor({ apply: true })

      expect(mockPromptDriftChoice).not.toHaveBeenCalled()
      expect(readFileSync(join(repoRoot, 'nx.json'), 'utf8')).toBe('{"stale": true}')
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Everything is in sync'))
    })
  })
})
