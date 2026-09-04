// Both shell-outs are mocked: `nx sync` and the formatter pass. The suite
// asserts the drift findings and the manifests on disk, never a subprocess.
jest.mock('../nx', () => ({
  runShell: jest.fn(() => 0),
  runFormatter: jest.fn(),
  runCapture: jest.fn(() => ({ status: 1, stdout: '' }))
}))

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFormatter, runShell } from '../nx'
import { collectDrift, resolveEcosystems, runSync } from './sync'

const mockRunShell = jest.mocked(runShell)
const mockRunFormatter = jest.mocked(runFormatter)

let workspaceRoot: string

/**
 * Writes a file, creating its directory first.
 *
 * @param relativePath - Path relative to the temp workspace root.
 * @param content - The file content.
 * @returns The absolute path written.
 */
function write (relativePath: string, content: string): string {
  const path = join(workspaceRoot, relativePath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

/**
 * Reads a JSON manifest back.
 *
 * @param relativePath - Path relative to the temp workspace root.
 * @returns The parsed manifest.
 */
function readManifest (relativePath: string): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(join(workspaceRoot, relativePath), 'utf8')) as Record<
    string,
    Record<string, string>
  >
}

/** A minimal workspace with two projects disagreeing about one package. */
function seedDriftedWorkspace (): void {
  write('nx.json', JSON.stringify({}))
  write('package.json', JSON.stringify({ name: '@demo/source', devDependencies: {} }))
  write('packages/auth/package.json', JSON.stringify({ dependencies: { axios: '^1.7.2' } }))
  write('packages/api/package.json', JSON.stringify({ dependencies: { axios: '^1.9.0' } }))
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-sync-'))
  mockRunShell.mockReturnValue(0)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
  process.exitCode = undefined
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
  process.exitCode = undefined
})

describe('resolveEcosystems', () => {
  it('defaults to every ecosystem', () => {
    expect(resolveEcosystems(undefined)).toEqual(['npm', 'pip', 'pub', 'go'])
  })

  it('narrows to the one requested', () => {
    expect(resolveEcosystems('pip')).toEqual(['pip'])
  })

  it('throws on an unknown value rather than silently checking nothing', () => {
    // A typo must not produce a confident "everything agrees".
    expect(() => resolveEcosystems('npmm')).toThrow('Unknown ecosystem')
  })
})

describe('collectDrift', () => {
  it('finds a package declared at two versions', () => {
    seedDriftedWorkspace()

    const drift = collectDrift(workspaceRoot, ['npm'])

    expect(drift).toHaveLength(1)
    expect(drift[0].name).toBe('axios')
    // Nothing installed, so the highest declared range wins — and the finding
    // says so, rather than implying it was resolved.
    expect(drift[0].reason).toBe('highest')
    expect(drift[0].target).toBe('^1.9.0')
    expect(drift[0].fixable.map(site => site.project)).toEqual(['packages/auth'])
  })

  it('converges on the INSTALLED version when there is one', () => {
    // The property that makes this command and `@nx/dependency-checks` agree:
    // the lint rule's own auto-fix pins a drifted range to what is installed.
    seedDriftedWorkspace()
    write('node_modules/axios/package.json', JSON.stringify({ version: '1.8.4' }))

    const drift = collectDrift(workspaceRoot, ['npm'])

    expect(drift[0].reason).toBe('resolved')
    expect(drift[0].target).toBe('^1.8.4')
    expect(drift[0].fixable).toHaveLength(2)
  })

  it('keeps the operator the majority of sites already use', () => {
    // A workspace that pins exactly stays pinned; widening it is a behaviour
    // change nobody asked for.
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ name: '@demo/source' }))
    write('packages/a/package.json', JSON.stringify({ dependencies: { axios: '1.7.2' } }))
    write('packages/b/package.json', JSON.stringify({ dependencies: { axios: '1.9.0' } }))
    write('packages/c/package.json', JSON.stringify({ dependencies: { axios: '^1.9.0' } }))
    write('node_modules/axios/package.json', JSON.stringify({ version: '1.8.4' }))

    expect(collectDrift(workspaceRoot, ['npm'])[0].target).toBe('1.8.4')
  })

  it('reports a spec it cannot rewrite as blocked rather than fixing it', () => {
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ name: '@demo/source' }))
    write('packages/a/package.json', JSON.stringify({ dependencies: { thing: '^1.0.0' } }))
    write(
      'packages/b/package.json',
      JSON.stringify({ dependencies: { thing: 'git+https://example.test/a.git' } })
    )

    const drift = collectDrift(workspaceRoot, ['npm'])
    expect(drift[0].blocked.map(site => site.project)).toEqual(['packages/b'])
    expect(drift[0].fixable).toHaveLength(0)
  })

  it('ignores a workspace-internal package', () => {
    // An internal lib is symlinked and versioned by `nx release`; its range is
    // deliberately loose so the link and the tag both satisfy it.
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ name: '@demo/source' }))
    write('packages/core/package.json', JSON.stringify({ name: '@demo/core', version: '1.0.0' }))
    write('packages/a/package.json', JSON.stringify({ dependencies: { '@demo/core': '^1.0.0' } }))
    write('packages/b/package.json', JSON.stringify({ dependencies: { '@demo/core': '*' } }))

    expect(collectDrift(workspaceRoot, ['npm'])).toHaveLength(0)
  })

  it('never reports a peer range as drift', () => {
    // Two published plugins peering the same package at different floors are
    // not in conflict — they are making different, equally valid compatibility
    // statements. The first run of this command against mnci's own repo
    // reported six findings, five of which were exactly this.
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ devDependencies: { '@nx/devkit': '23.1.1' } }))
    write(
      'packages/a/package.json',
      JSON.stringify({ peerDependencies: { '@nx/devkit': '>=21.0.0' } })
    )
    write(
      'packages/b/package.json',
      JSON.stringify({ peerDependencies: { '@nx/devkit': '>=22.0.0' } })
    )

    expect(collectDrift(workspaceRoot, ['npm'])).toHaveLength(0)
  })

  it('still converges the real declarations of a package that is also a peer', () => {
    // Excluding peers must not make the rest of a package's declarations
    // invisible — only the peer range itself is off limits.
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ devDependencies: { thing: '^1.0.0' } }))
    write('packages/a/package.json', JSON.stringify({ dependencies: { thing: '^2.0.0' } }))
    write('packages/b/package.json', JSON.stringify({ peerDependencies: { thing: '>=1.0.0' } }))

    const drift = collectDrift(workspaceRoot, ['npm'])
    expect(drift).toHaveLength(1)
    expect(drift[0].target).toBe('^2.0.0')
    expect([...drift[0].fixable, ...drift[0].blocked].map(site => site.project)).toEqual([
      '(root)'
    ])
  })

  it('reports nothing when every project agrees', () => {
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ name: '@demo/source' }))
    write('packages/a/package.json', JSON.stringify({ dependencies: { axios: '^1.9.0' } }))
    write('packages/b/package.json', JSON.stringify({ dependencies: { axios: '^1.9.0' } }))

    expect(collectDrift(workspaceRoot, ['npm'])).toHaveLength(0)
  })

  it('never reports Go, which has one manifest and so cannot disagree', () => {
    write('nx.json', JSON.stringify({}))
    write(
      'go.mod',
      'module github.com/demo/repo\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n)\n'
    )

    expect(collectDrift(workspaceRoot, ['go'])).toHaveLength(0)
  })

  it('converges pip specifiers across projects', () => {
    write('nx.json', JSON.stringify({}))
    write('libs/a/pyproject.toml', '[project]\ndependencies = ["requests>=2.31.0"]\n')
    write('libs/b/pyproject.toml', '[project]\ndependencies = ["requests>=2.28.0"]\n')

    const drift = collectDrift(workspaceRoot, ['pip'])
    expect(drift[0].name).toBe('requests')
    expect(drift[0].target).toBe('>=2.31.0')
  })
})

describe('runSync', () => {
  it('refuses to run outside a workspace', () => {
    expect(() => {
      runSync(workspaceRoot, {})
    }).toThrow('No nx.json found')
  })

  it('writes the converged range and runs nx sync', () => {
    seedDriftedWorkspace()

    runSync(workspaceRoot, {})

    expect(readManifest('packages/auth/package.json').dependencies.axios).toBe('^1.9.0')
    expect(mockRunShell).toHaveBeenCalledWith('npx', ['nx', 'sync'], workspaceRoot)
    expect(mockRunFormatter).toHaveBeenCalled()
  })

  it('--check reports and fails without touching a single file', () => {
    seedDriftedWorkspace()

    runSync(workspaceRoot, { check: true })

    expect(process.exitCode).toBe(1)
    // Unchanged on disk — the whole contract of a read-only mode.
    expect(readManifest('packages/auth/package.json').dependencies.axios).toBe('^1.7.2')
    expect(mockRunShell).not.toHaveBeenCalled()
    expect(mockRunFormatter).not.toHaveBeenCalled()
  })

  it('--check exits zero when everything already agrees', () => {
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ name: '@demo/source' }))
    write('packages/a/package.json', JSON.stringify({ dependencies: { axios: '^1.9.0' } }))

    runSync(workspaceRoot, { check: true })

    expect(process.exitCode).toBeUndefined()
  })

  it('skips the formatter when nothing changed', () => {
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ name: '@demo/source' }))

    runSync(workspaceRoot, {})

    expect(mockRunFormatter).not.toHaveBeenCalled()
  })

  it('rejects an unknown --ecosystem before doing any work', () => {
    write('nx.json', JSON.stringify({}))
    expect(() => {
      runSync(workspaceRoot, { ecosystem: 'cargo' })
    }).toThrow('Unknown ecosystem')
  })
})
