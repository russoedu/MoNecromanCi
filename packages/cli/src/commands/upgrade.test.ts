// `runUpgrade` ends with runFormatter, which shells out to `npx prettier`. These
// tests run in a bare temp dir with no node_modules, so a real call would try to
// fetch prettier from the network — slow, and flaky offline. Mocked, and
// asserted on directly below, since "upgrade formats what it rewrote" is one of
// the behaviours under test.
jest.mock('../nx', () => ({ runFormatter: jest.fn() }))

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFormatter } from '../nx'
import { applyOverlay, DEFAULT_STACK, type OverlayOptions } from '../overlay'
import { runUpgrade } from './upgrade'

const mockRunFormatter = jest.mocked(runFormatter)

/** The overlay options a seeded fixture workspace was generated with. */
const FIXTURE_OPTIONS: OverlayOptions = {
  workspaceName: 'demo',
  scope: '@demo',
  registry: { kind: 'npm' },
  agent: 'ubuntu-latest',
  variableGroup: 'Build',
  ci: 'github',
  stack: DEFAULT_STACK
}

let workspaceRoot: string

/** Seeds a fresh temp dir with the two files a real `create-nx-workspace` leaves for applyOverlay to patch. */
function seedWorkspace(): void {
  writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ $schema: 's', namedInputs: {} }))
  writeFileSync(
    join(workspaceRoot, 'package.json'),
    JSON.stringify({ name: '@org/source', private: true, devDependencies: { nx: '23.0.0' } })
  )
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
    applyOverlay(workspaceRoot, FIXTURE_OPTIONS)
    // Simulate drift since generation — upgrade should overwrite this back to today's content.
    writeFileSync(join(workspaceRoot, '.github/workflows/ci.yml'), 'stale hand-edited content')

    runUpgrade(workspaceRoot, {})

    const workflow = readFileSync(join(workspaceRoot, '.github/workflows/ci.yml'), 'utf8')
    expect(workflow).toContain('runs-on: ubuntu-latest')
    expect(workflow).not.toBe('stale hand-edited content')
  })

  it('lets an explicit flag override the persisted value, and persists the override for next time', () => {
    seedWorkspace()
    applyOverlay(workspaceRoot, FIXTURE_OPTIONS)

    runUpgrade(workspaceRoot, { agent: 'windows-latest' })

    const workflow = readFileSync(join(workspaceRoot, '.github/workflows/ci.yml'), 'utf8')
    expect(workflow).toContain('runs-on: windows-latest')
    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as {
      mnci: { agent: string }
    }
    expect(nxJson.mnci.agent).toBe('windows-latest')
  })

  it('switches CI provider files (github -> both) via an explicit --ci flag', () => {
    seedWorkspace()
    applyOverlay(workspaceRoot, FIXTURE_OPTIONS)

    runUpgrade(workspaceRoot, { ci: 'both' })

    expect(readFileSync(join(workspaceRoot, 'azure-pipelines.yml'), 'utf8')).toContain(
      'vmImage: ubuntu-latest'
    )
  })

  it('throws a clear, actionable error naming the missing flag for a workspace with no persisted scope', () => {
    writeFileSync(
      join(workspaceRoot, 'nx.json'),
      JSON.stringify({
        $schema: 's',
        namedInputs: {},
        mnci: { stack: { testRunner: 'jest' } }
      })
    )
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@org/source' }))

    expect(() => runUpgrade(workspaceRoot, {})).toThrow('No npm scope found')
  })

  it('throws naming --ci when the persisted config has a scope but no ci provider', () => {
    writeFileSync(
      join(workspaceRoot, 'nx.json'),
      JSON.stringify({
        $schema: 's',
        namedInputs: {},
        mnci: {
          scope: '@demo',
          registry: { kind: 'npm' },
          stack: { testRunner: 'jest' }
        }
      })
    )
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@demo/source' }))

    expect(() => runUpgrade(workspaceRoot, {})).toThrow('No CI provider found')
  })

  it('throws naming the Azure Artifacts flags when switching registries without coordinates', () => {
    seedWorkspace()
    applyOverlay(workspaceRoot, FIXTURE_OPTIONS)

    expect(() => runUpgrade(workspaceRoot, { registry: 'azure-artifacts' })).toThrow(
      'Azure Artifacts registry needs --organization, --project and --artifacts-feed'
    )
  })

  it('resolves azure-artifacts coordinates from flags even when the persisted registry is npm', () => {
    seedWorkspace()
    applyOverlay(workspaceRoot, FIXTURE_OPTIONS)

    runUpgrade(workspaceRoot, {
      registry: 'azure-artifacts',
      organization: 'org',
      project: 'proj',
      artifactsFeed: 'feed'
    })

    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as {
      mnci: { registry: unknown }
    }
    expect(nxJson.mnci.registry).toEqual({
      kind: 'azure-artifacts',
      organization: 'org',
      project: 'proj',
      artifactsFeed: 'feed'
    })
  })

  it('rewrites the real <name>.code-workspace, never a file called undefined.code-workspace', () => {
    seedWorkspace()
    applyOverlay(workspaceRoot, FIXTURE_OPTIONS)

    runUpgrade(workspaceRoot, {})

    // The bug: resolveOverlayOptions omitted workspaceName, so this write landed
    // on the literal filename `undefined.code-workspace` and the workspace's real
    // one was never refreshed — making .code-workspace the single mnci-owned file
    // an upgrade could not carry a fix into.
    const codeWorkspaces = readdirSync(workspaceRoot).filter(f => f.endsWith('.code-workspace'))
    expect(codeWorkspaces).toEqual(['demo.code-workspace'])
  })

  it('deletes the undefined.code-workspace a previous buggy upgrade left behind', () => {
    seedWorkspace()
    applyOverlay(workspaceRoot, FIXTURE_OPTIONS)
    // Exactly what a workspace upgraded before the fix carries. Only an upgrade
    // can clear it, so the repair has to live here.
    writeFileSync(join(workspaceRoot, 'undefined.code-workspace'), '{}')

    runUpgrade(workspaceRoot, {})

    const codeWorkspaces = readdirSync(workspaceRoot).filter(f => f.endsWith('.code-workspace'))
    expect(codeWorkspaces).toEqual(['demo.code-workspace'])
  })

  it('recovers the workspace name from an existing file when nothing is persisted', () => {
    // A workspace generated before mnciConfig persisted workspaceName: the
    // fallback chain reads it off the existing filename rather than giving up.
    writeFileSync(
      join(workspaceRoot, 'nx.json'),
      JSON.stringify({
        $schema: 's',
        namedInputs: {},
        mnci: {
          scope: '@demo',
          registry: { kind: 'npm' },
          agent: 'ubuntu-latest',
          ci: 'github',
          stack: { testRunner: 'jest' }
        }
      })
    )
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@demo/source' }))
    writeFileSync(join(workspaceRoot, 'legacy-name.code-workspace'), '{}')

    runUpgrade(workspaceRoot, {})

    const codeWorkspaces = readdirSync(workspaceRoot).filter(f => f.endsWith('.code-workspace'))
    expect(codeWorkspaces).toEqual(['legacy-name.code-workspace'])
  })

  it('preserves the per-project VS Code tasks that mnci add registered', () => {
    seedWorkspace()
    applyOverlay(workspaceRoot, FIXTURE_OPTIONS)
    // What `registerProjectCommands` writes for each added project. The overlay
    // owns this file's folders/settings/extensions but NOT its tasks, so
    // regenerating it wholesale wipes them.
    const path = join(workspaceRoot, 'demo.code-workspace')
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      tasks: { version: string; tasks: Record<string, unknown>[] }
    }
    file.tasks.tasks = [
      { label: 'web: qa', type: 'npm', script: 'web:qa' },
      { label: 'web: build', type: 'npm', script: 'web:build' }
    ]
    writeFileSync(path, JSON.stringify(file, undefined, 2))

    runUpgrade(workspaceRoot, {})

    // This regression was masked by the filename bug: while upgrade wrote to
    // `undefined.code-workspace`, the real file's tasks survived by accident.
    // Fixing the filename destroyed all five tasks in a real three-project
    // workspace before this preservation was added.
    const after = JSON.parse(readFileSync(path, 'utf8')) as {
      tasks: { tasks: { label: string }[] }
      folders: { name: string }[]
    }
    expect(after.tasks.tasks.map(t => t.label)).toEqual(['web: qa', 'web: build'])
    // ...while the overlay-owned parts are still regenerated.
    expect(after.folders).toEqual([{ path: '.', name: 'demo' }])
  })

  it('formats the workspace afterwards, so the nx.json it rewrote passes format:check', () => {
    seedWorkspace()
    applyOverlay(workspaceRoot, FIXTURE_OPTIONS)
    mockRunFormatter.mockClear()

    runUpgrade(workspaceRoot, {})

    // `new` and every `add` already did this; upgrade did not, leaving the
    // workspace failing its own CI formatting gate right after an upgrade.
    expect(mockRunFormatter).toHaveBeenCalledWith(workspaceRoot, 'eslint')
  })
})
