import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configFromVars, isManagedRepo, loadConfig, saveConfig, stampPath } from './config'
import { TEMPLATE_VERSION } from './constants'
import type { MonorepoVars } from './types'

const vars: MonorepoVars = {
  workspaceName:   'demo',
  displayName:     'Demo',
  scope:           '@demo',
  defaultBase:     'main',
  nodeVersion:     '24',
  ci:              'azure',
  registry:        { kind: 'azure-artifacts', organization: 'org', project: 'proj', artifactsFeed: 'feed' },
  triggerBranches: ['dev', 'main'],
}

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'monecromanci-config-'))
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('stampPath', () => {
  it('points at .monecromanci.json under the repo root', () => {
    expect(stampPath(repoRoot)).toBe(join(repoRoot, '.monecromanci.json'))
  })
})

describe('isManagedRepo', () => {
  it('is false when no stamp exists', () => {
    expect(isManagedRepo(repoRoot)).toBe(false)
  })

  it('is true once a stamp has been written', () => {
    saveConfig(repoRoot, configFromVars(vars))
    expect(isManagedRepo(repoRoot)).toBe(true)
  })
})

describe('loadConfig', () => {
  it('returns undefined when the repo is not managed', () => {
    expect(loadConfig(repoRoot)).toBeUndefined()
  })

  it('returns the saved config when the repo is managed', () => {
    const config = configFromVars(vars)
    saveConfig(repoRoot, config)
    expect(loadConfig(repoRoot)).toEqual(config)
  })

  it('returns undefined when the stamp exists but is not valid JSON', () => {
    writeFileSync(stampPath(repoRoot), '{ not valid json', 'utf8')
    expect(loadConfig(repoRoot)).toBeUndefined()
  })

  it('migrates a legacy v1 stamp (azure field) to the ci/registry shape', () => {
    writeFileSync(stampPath(repoRoot), JSON.stringify({
      templateVersion: '0.1.0',
      workspaceName:   'legacy',
      displayName:     'Legacy',
      scope:           '@legacy',
      defaultBase:     'main',
      nodeVersion:     '24',
      azure:           { organization: 'org', project: 'proj', artifactsFeed: 'feed' },
    }), 'utf8')

    const config = loadConfig(repoRoot)

    expect(config?.ci).toBe('azure')
    expect(config?.registry).toEqual({ kind: 'azure-artifacts', organization: 'org', project: 'proj', artifactsFeed: 'feed' })
  })

  it('migrates a legacy stamp without azure coordinates to the public npm registry', () => {
    writeFileSync(stampPath(repoRoot), JSON.stringify({
      templateVersion: '0.1.0',
      workspaceName:   'legacy',
      displayName:     'Legacy',
      scope:           '@legacy',
      defaultBase:     'main',
      nodeVersion:     '24',
    }), 'utf8')

    const config = loadConfig(repoRoot)

    expect(config?.ci).toBe('azure')
    expect(config?.registry).toEqual({ kind: 'npm' })
  })
})

describe('configFromVars', () => {
  it('maps monorepo vars onto the stamp shape with the current template version', () => {
    expect(configFromVars(vars)).toEqual({
      templateVersion: TEMPLATE_VERSION,
      workspaceName:   'demo',
      displayName:     'Demo',
      scope:           '@demo',
      defaultBase:     'main',
      nodeVersion:     '24',
      ci:              'azure',
      registry:        { kind: 'azure-artifacts', organization: 'org', project: 'proj', artifactsFeed: 'feed' },
      triggerBranches: ['dev', 'main'],
    })
  })
})
