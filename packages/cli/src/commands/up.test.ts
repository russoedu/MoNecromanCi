// @inquirer/prompts ships ESM only, so it must be mocked for jest to load this
// module at all — and mocking it is what lets the selection be driven directly.
jest.mock('@inquirer/prompts', () => ({
  checkbox: jest.fn(),
  Separator: class {
    constructor (public readonly separator: string) {}
  }
}))
jest.mock('../nx', () => ({
  runShell: jest.fn(() => 0),
  runFormatter: jest.fn(),
  runCapture: jest.fn(() => ({ status: 1, stdout: '' }))
}))
// The registry is the one thing this command cannot own: stubbed so the suite
// asserts what mnci does with an answer, never what npm replies.
jest.mock('../deps/registry', () => ({ latestVersions: jest.fn() }))

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkbox } from '@inquirer/prompts'
import { latestVersions } from '../deps/registry'
import { runFormatter, runShell } from '../nx'
import { collectOutdated, runUp } from './up'

const mockCheckbox = jest.mocked(checkbox)
const mockLatestVersions = jest.mocked(latestVersions)
const mockRunShell = jest.mocked(runShell)
const mockRunFormatter = jest.mocked(runFormatter)

let workspaceRoot: string
let logged: string[]

/** Explicit comparator, so a sort is never left to string coercion. */
const compare = (left: string, right: string): number => left.localeCompare(right)

/**
 * Writes a file, creating its directory first.
 *
 * @param relativePath - Path relative to the temp workspace root.
 * @param content - The file content.
 * @returns Nothing.
 */
function write (relativePath: string, content: string): void {
  const path = join(workspaceRoot, relativePath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
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

/** A workspace where two projects both declare axios, resolved at 1.7.2. */
function seedWorkspace (): void {
  write('nx.json', JSON.stringify({}))
  write('package.json', JSON.stringify({ name: '@demo/source', scripts: {} }))
  write('packages/auth/package.json', JSON.stringify({ dependencies: { axios: '^1.7.2' } }))
  write('packages/api/package.json', JSON.stringify({ dependencies: { axios: '^1.7.2' } }))
  write('node_modules/axios/package.json', JSON.stringify({ version: '1.7.2' }))
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-up-'))
  logged = []
  mockRunShell.mockReturnValue(0)
  mockLatestVersions.mockResolvedValue(new Map())
  mockCheckbox.mockResolvedValue([])
  jest.spyOn(console, 'log').mockImplementation((message: unknown) => {
    logged.push(String(message))
  })
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
  // `runUp` falls back to report-only when stdout is not a TTY, which is what
  // jest gives it. Interactive behaviour has to be asked for explicitly.
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true, writable: true })
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
  Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true, writable: true })
})

describe('collectOutdated', () => {
  it('reports a package with a newer release, and every project declaring it', async () => {
    seedWorkspace()
    mockLatestVersions.mockResolvedValue(new Map([['axios', '1.9.0']]))

    const outdated = await collectOutdated(workspaceRoot, ['npm'])

    expect(outdated).toHaveLength(1)
    expect(outdated[0]).toMatchObject({ name: 'axios', current: '1.7.2', latest: '1.9.0' })
    // The column npm-check cannot produce in a monorepo, and the reason this
    // command exists rather than a plain `npm-check` invocation.
    expect(outdated[0].sites.map(site => site.project).toSorted(compare)).toEqual([
      'packages/api',
      'packages/auth'
    ])
  })

  it('measures from the RESOLVED version, not the declared range', async () => {
    seedWorkspace()
    write('node_modules/axios/package.json', JSON.stringify({ version: '1.8.4' }))
    mockLatestVersions.mockResolvedValue(new Map([['axios', '1.9.0']]))

    const outdated = await collectOutdated(workspaceRoot, ['npm'])
    expect(outdated[0].current).toBe('1.8.4')
    expect(outdated[0].kind).toBe('minor')
  })

  it('says nothing about a package already on its latest release', async () => {
    seedWorkspace()
    mockLatestVersions.mockResolvedValue(new Map([['axios', '1.7.2']]))

    expect(await collectOutdated(workspaceRoot, ['npm'])).toHaveLength(0)
  })

  it('sorts least-risky first, as npm-check does', async () => {
    write('nx.json', JSON.stringify({}))
    write(
      'package.json',
      JSON.stringify({ devDependencies: { big: '^1.0.0', small: '^1.0.0', zero: '^0.1.0' } })
    )
    write('node_modules/big/package.json', JSON.stringify({ version: '1.0.0' }))
    write('node_modules/small/package.json', JSON.stringify({ version: '1.0.0' }))
    write('node_modules/zero/package.json', JSON.stringify({ version: '0.1.0' }))
    mockLatestVersions.mockResolvedValue(
      new Map([
        ['big', '2.0.0'],
        ['small', '1.0.1'],
        ['zero', '0.2.0']
      ])
    )

    const outdated = await collectOutdated(workspaceRoot, ['npm'])
    expect(outdated.map(entry => entry.kind)).toEqual(['patch', 'major', 'non-semver'])
  })

  it('handles Go, whose versions carry a leading v', async () => {
    // Without stripping it, every Go module reads as unparseable and the whole
    // ecosystem silently reports no updates.
    write('nx.json', JSON.stringify({}))
    write('go.mod', 'module demo\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n)\n')
    mockLatestVersions.mockResolvedValue(new Map([['github.com/spf13/cobra', 'v1.9.1']]))

    const outdated = await collectOutdated(workspaceRoot, ['go'])
    expect(outdated).toHaveLength(1)
    expect(outdated[0].kind).toBe('minor')
  })

  it('never offers a package declared only as a peer dependency', async () => {
    // A peer range says which versions a published package supports, not which
    // one this workspace uses — there is no upgrade to offer, and writing one
    // would narrow the package's compatibility.
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ name: '@demo/source' }))
    write(
      'packages/plugin/package.json',
      JSON.stringify({ peerDependencies: { '@nx/devkit': '>=21.0.0' } })
    )
    write('node_modules/@nx/devkit/package.json', JSON.stringify({ version: '23.1.1' }))
    mockLatestVersions.mockResolvedValue(new Map([['@nx/devkit', '23.2.0']]))

    expect(await collectOutdated(workspaceRoot, ['npm'])).toHaveLength(0)
  })

  it('offers a package that is a peer somewhere and a real dependency elsewhere', async () => {
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ devDependencies: { '@nx/devkit': '^23.1.1' } }))
    write(
      'packages/plugin/package.json',
      JSON.stringify({ peerDependencies: { '@nx/devkit': '>=21.0.0' } })
    )
    write('node_modules/@nx/devkit/package.json', JSON.stringify({ version: '23.1.1' }))
    mockLatestVersions.mockResolvedValue(new Map([['@nx/devkit', '23.2.0']]))

    const outdated = await collectOutdated(workspaceRoot, ['npm'])
    expect(outdated).toHaveLength(1)
    // Both declarations are shown, so the reader sees who is affected...
    expect(outdated[0].sites).toHaveLength(2)

    mockCheckbox.mockResolvedValue(outdated)
    await runUp(workspaceRoot, { install: false })

    // ...but only the real one is rewritten.
    expect(readManifest('package.json').devDependencies['@nx/devkit']).toBe('^23.2.0')
    expect(readManifest('packages/plugin/package.json').peerDependencies['@nx/devkit']).toBe(
      '>=21.0.0'
    )
  })

  it('never offers an aliased install, whose key names a different package', async () => {
    // mnci's own root manifest pins the dual TypeScript compiler as
    // `typescript: npm:@typescript/typescript6@^6.0.2`. Asking the registry
    // about the KEY answers about real TypeScript — the first `mnci up` run on
    // this repo offered "typescript 6.0.2 to 7.0.2", which is a different
    // package's version entirely.
    write('nx.json', JSON.stringify({}))
    write(
      'package.json',
      JSON.stringify({ devDependencies: { typescript: 'npm:@typescript/typescript6@^6.0.2' } })
    )
    write(
      'node_modules/typescript/package.json',
      JSON.stringify({ name: '@typescript/typescript6', version: '6.0.2' })
    )
    mockLatestVersions.mockResolvedValue(new Map([['typescript', '7.0.2']]))

    expect(await collectOutdated(workspaceRoot, ['npm'])).toHaveLength(0)
  })

  it('still offers a package installed under its own name', async () => {
    // The alias check must not swallow every normal dependency with it.
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ devDependencies: { axios: '^1.7.2' } }))
    write('node_modules/axios/package.json', JSON.stringify({ name: 'axios', version: '1.7.2' }))
    mockLatestVersions.mockResolvedValue(new Map([['axios', '1.9.0']]))

    expect(await collectOutdated(workspaceRoot, ['npm'])).toHaveLength(1)
  })

  it("never offers one of the workspace's own projects", async () => {
    // A workspace project is symlinked and versioned by `nx release`; replacing
    // the link with a published copy is not an upgrade, it is a regression.
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ devDependencies: { '@demo/core': '*' } }))
    write('packages/core/package.json', JSON.stringify({ name: '@demo/core', version: '0.1.0' }))
    write('node_modules/@demo/core/package.json', JSON.stringify({ name: '@demo/core', version: '0.1.0' }))
    mockLatestVersions.mockResolvedValue(new Map([['@demo/core', '0.3.4']]))

    expect(await collectOutdated(workspaceRoot, ['npm'])).toHaveLength(0)
  })

  it('never offers an indirect Go module, which go mod tidy owns', async () => {
    write('nx.json', JSON.stringify({}))
    write('go.mod', 'module demo\n\nrequire (\n\tgithub.com/x/y v1.0.0 // indirect\n)\n')
    mockLatestVersions.mockResolvedValue(new Map([['github.com/x/y', 'v1.1.0']]))

    expect(await collectOutdated(workspaceRoot, ['go'])).toHaveLength(0)
  })
})

describe('runUp', () => {
  it('refuses to run outside a workspace', async () => {
    await expect(runUp(workspaceRoot, {})).rejects.toThrow('No nx.json found')
  })

  it('--check reports without prompting or writing', async () => {
    seedWorkspace()
    mockLatestVersions.mockResolvedValue(new Map([['axios', '1.9.0']]))

    await runUp(workspaceRoot, { check: true })

    expect(mockCheckbox).not.toHaveBeenCalled()
    expect(readManifest('packages/auth/package.json').dependencies.axios).toBe('^1.7.2')
    // The report carries the section heading and the projects column.
    expect(logged.join('\n')).toContain('Minor Update')
    expect(logged.join('\n')).toContain('packages/auth')
  })

  it('updates EVERY project declaring a selected package', async () => {
    // Updating only one of them is how a workspace acquires the drift `mnci
    // sync` then has to repair.
    seedWorkspace()
    mockLatestVersions.mockResolvedValue(new Map([['axios', '1.9.0']]))
    const outdated = await collectOutdated(workspaceRoot, ['npm'])
    mockCheckbox.mockResolvedValue(outdated)

    await runUp(workspaceRoot, { install: false })

    expect(readManifest('packages/auth/package.json').dependencies.axios).toBe('^1.9.0')
    expect(readManifest('packages/api/package.json').dependencies.axios).toBe('^1.9.0')
  })

  it('preserves the range operator each site already used', async () => {
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ name: '@demo/source' }))
    write('packages/a/package.json', JSON.stringify({ dependencies: { axios: '1.7.2' } }))
    write('packages/b/package.json', JSON.stringify({ dependencies: { axios: '~1.7.2' } }))
    write('node_modules/axios/package.json', JSON.stringify({ version: '1.7.2' }))
    mockLatestVersions.mockResolvedValue(new Map([['axios', '1.9.0']]))
    mockCheckbox.mockResolvedValue((await collectOutdated(workspaceRoot, ['npm'])))

    await runUp(workspaceRoot, { install: false })

    expect(readManifest('packages/a/package.json').dependencies.axios).toBe('1.9.0')
    expect(readManifest('packages/b/package.json').dependencies.axios).toBe('~1.9.0')
  })

  it('writes nothing when the prompt comes back empty', async () => {
    seedWorkspace()
    mockLatestVersions.mockResolvedValue(new Map([['axios', '1.9.0']]))
    mockCheckbox.mockResolvedValue([])

    await runUp(workspaceRoot, {})

    expect(readManifest('packages/auth/package.json').dependencies.axios).toBe('^1.7.2')
    expect(mockRunFormatter).not.toHaveBeenCalled()
  })

  it('--yes takes every update without prompting', async () => {
    seedWorkspace()
    mockLatestVersions.mockResolvedValue(new Map([['axios', '1.9.0']]))

    await runUp(workspaceRoot, { yes: true, install: false })

    expect(mockCheckbox).not.toHaveBeenCalled()
    expect(readManifest('packages/auth/package.json').dependencies.axios).toBe('^1.9.0')
  })

  it('reinstalls unless --no-install was passed', async () => {
    seedWorkspace()
    mockLatestVersions.mockResolvedValue(new Map([['axios', '1.9.0']]))

    await runUp(workspaceRoot, { yes: true })

    expect(mockRunShell).toHaveBeenCalledWith('npm', ['install'], workspaceRoot)
  })

  it('upgrades a Go module through the toolchain, never by editing go.mod', async () => {
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ name: '@demo/source' }))
    const goMod = 'module demo\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n)\n'
    write('go.mod', goMod)
    mockLatestVersions.mockImplementation(async ecosystem =>
      ecosystem === 'go' ? new Map([['github.com/spf13/cobra', 'v1.9.1']]) : new Map()
    )

    await runUp(workspaceRoot, { yes: true, install: false })

    expect(mockRunShell).toHaveBeenCalledWith(
      'go',
      ['get', 'github.com/spf13/cobra@v1.9.1'],
      workspaceRoot
    )
    // go.mod is untouched by mnci — `go get` owns it.
    expect(readFileSync(join(workspaceRoot, 'go.mod'), 'utf8')).toBe(goMod)
  })

  it('warns instead of guessing when a workspace has no python:install script', async () => {
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ name: '@demo/source', scripts: {} }))
    write('libs/shared/pyproject.toml', '[project]\ndependencies = ["requests>=2.31.0"]\n')
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockLatestVersions.mockImplementation(async ecosystem =>
      ecosystem === 'pip' ? new Map([['requests', '2.32.3']]) : new Map()
    )

    await runUp(workspaceRoot, { yes: true })

    expect(warn.mock.calls.flat().join('\n')).toContain('python:install')
  })

  it('rejects an unknown --ecosystem before querying anything', async () => {
    write('nx.json', JSON.stringify({}))
    await expect(runUp(workspaceRoot, { ecosystem: 'cargo' })).rejects.toThrow('Unknown ecosystem')
    expect(mockLatestVersions).not.toHaveBeenCalled()
  })

  it('reports an absent ecosystem as a loud SKIPPED', async () => {
    // Never silently dropped: that is how Go went uncovered for months.
    write('nx.json', JSON.stringify({}))
    write('package.json', JSON.stringify({ name: '@demo/source' }))

    await runUp(workspaceRoot, { check: true })

    expect(logged.join('\n')).toContain('SKIPPED go')
  })
})
