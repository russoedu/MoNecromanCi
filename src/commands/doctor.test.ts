import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TAGS, TEMPLATE_VERSION } from '../engine/constants'
import type { MonecromanciConfig } from '../engine/types'

jest.mock('../engine/sync', () => ({ syncToolOwned: jest.fn() }))

import * as configModule from '../engine/config'
import { loadConfig, saveConfig } from '../engine/config'
import { syncToolOwned } from '../engine/sync'
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
}

const mockSyncToolOwned = jest.mocked(syncToolOwned)

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
  })

  it('reports issues without writing fixes when apply is false', async () => {
    saveConfig(repoRoot, config)
    mockSyncToolOwned.mockReturnValue({ ok: [], missing: ['m.json'], drift: ['d.json'], fixed: [] })
    await runDoctor({ apply: false })
    expect(warnSpy).toHaveBeenCalledWith('! missing: m.json')
    expect(warnSpy).toHaveBeenCalledWith('! drift:   d.json')
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Re-run with --fix'))
  })

  it('repairs drift and re-stamps the template version when apply is true', async () => {
    saveConfig(repoRoot, config)
    mockSyncToolOwned.mockReturnValue({ ok: [], missing: ['m.json'], drift: [], fixed: ['m.json'] })
    await runDoctor({ apply: true })
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('fixed:   m.json'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`Repaired 1 file(s); stamped template version ${TEMPLATE_VERSION}`))
    expect(loadConfig(repoRoot)?.templateVersion).toBe(TEMPLATE_VERSION)
  })

  it('calls saveConfig with the spread config and the current template version', async () => {
    saveConfig(repoRoot, config)
    const saveConfigSpy = jest.spyOn(configModule, 'saveConfig')
    mockSyncToolOwned.mockReturnValue({ ok: [], missing: [], drift: ['d.json'], fixed: ['d.json'] })
    await runDoctor({ apply: true })
    expect(saveConfigSpy).toHaveBeenCalledWith(repoRoot, { ...config, templateVersion: TEMPLATE_VERSION })
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
})
