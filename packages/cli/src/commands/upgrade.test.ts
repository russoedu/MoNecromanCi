import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyOverlay, DEFAULT_STACK } from '../overlay'
import { runUpgrade } from './upgrade'

let workspaceRoot: string

/** Seeds a fresh temp dir with the two files a real `create-nx-workspace` leaves for applyOverlay to patch. */
function seedWorkspace (): void {
  writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ $schema: 's', namedInputs: {} }))
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@org/source', private: true, devDependencies: { nx: '23.0.0' } }))
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-upgrade-'))
  jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

describe('runUpgrade', () => {
  it('throws when the directory has no nx.json (not an Nx workspace at all)', () => {
    expect(() => runUpgrade(workspaceRoot, {})).toThrow('No nx.json found')
  })

  it('re-applies the overlay from the persisted mnci config alone, restoring hand-drifted files', () => {
    seedWorkspace()
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' }, agent: 'ubuntu-latest', variableGroup: 'Build', ci: 'github', stack: DEFAULT_STACK })
    // Simulate drift since generation — upgrade should overwrite this back to today's content.
    writeFileSync(join(workspaceRoot, '.github/workflows/ci.yml'), 'stale hand-edited content')

    runUpgrade(workspaceRoot, {})

    const workflow = readFileSync(join(workspaceRoot, '.github/workflows/ci.yml'), 'utf8')
    expect(workflow).toContain('runs-on: ubuntu-latest')
    expect(workflow).not.toBe('stale hand-edited content')
  })

  it('lets an explicit flag override the persisted value, and persists the override for next time', () => {
    seedWorkspace()
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' }, agent: 'ubuntu-latest', variableGroup: 'Build', ci: 'github', stack: DEFAULT_STACK })

    runUpgrade(workspaceRoot, { agent: 'windows-latest' })

    const workflow = readFileSync(join(workspaceRoot, '.github/workflows/ci.yml'), 'utf8')
    expect(workflow).toContain('runs-on: windows-latest')
    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as { mnci: { agent: string } }
    expect(nxJson.mnci.agent).toBe('windows-latest')
  })

  it('switches CI provider files (github -> both) via an explicit --ci flag', () => {
    seedWorkspace()
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' }, agent: 'ubuntu-latest', variableGroup: 'Build', ci: 'github', stack: DEFAULT_STACK })

    runUpgrade(workspaceRoot, { ci: 'both' })

    expect(readFileSync(join(workspaceRoot, 'azure-pipelines.yml'), 'utf8')).toContain('vmImage: ubuntu-latest')
  })

  it('throws a clear, actionable error naming the missing flag for a workspace with no persisted scope', () => {
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ $schema: 's', namedInputs: {}, mnci: { stack: { linter: 'eslint', testRunner: 'jest' } } }))
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@org/source' }))

    expect(() => runUpgrade(workspaceRoot, {})).toThrow('No npm scope found')
  })

  it('throws naming --ci when the persisted config has a scope but no ci provider', () => {
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ $schema: 's', namedInputs: {}, mnci: { scope: '@demo', registry: { kind: 'npm' }, stack: { linter: 'eslint', testRunner: 'jest' } } }))
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@demo/source' }))

    expect(() => runUpgrade(workspaceRoot, {})).toThrow('No CI provider found')
  })

  it('throws naming the Azure Artifacts flags when switching registries without coordinates', () => {
    seedWorkspace()
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' }, agent: 'ubuntu-latest', variableGroup: 'Build', ci: 'github', stack: DEFAULT_STACK })

    expect(() => runUpgrade(workspaceRoot, { registry: 'azure-artifacts' })).toThrow('Azure Artifacts registry needs --organization, --project and --artifacts-feed')
  })

  it('resolves azure-artifacts coordinates from flags even when the persisted registry is npm', () => {
    seedWorkspace()
    applyOverlay(workspaceRoot, { scope: '@demo', registry: { kind: 'npm' }, agent: 'ubuntu-latest', variableGroup: 'Build', ci: 'github', stack: DEFAULT_STACK })

    runUpgrade(workspaceRoot, { registry: 'azure-artifacts', organization: 'org', project: 'proj', artifactsFeed: 'feed' })

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as { mnci: { registry: unknown } }
    expect(nxJson.mnci.registry).toEqual({ kind: 'azure-artifacts', organization: 'org', project: 'proj', artifactsFeed: 'feed' })
  })
})
