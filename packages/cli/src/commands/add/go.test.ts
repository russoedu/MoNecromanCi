jest.mock('../../nx', () => ({
  runNx: jest.fn(),
  runPrettier: jest.fn(),
  runShell: jest.fn(() => 0),
}))
jest.mock('../../prompts', () => ({ promptText: jest.fn() }))
jest.mock('@inquirer/prompts', () => ({ select: jest.fn(), input: jest.fn() }))

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runNx, runShell } from '../../nx'
import { runAdd } from '../add'

const mockRunNx = jest.mocked(runNx)
const mockRunShell = jest.mocked(runShell)

let workspaceRoot: string

/** Pre-creates the `project.json` the (mocked) plugin generator would write. */
function seedProjectJson(relativeDirectory: string, name: string): void {
  mkdirSync(join(workspaceRoot, relativeDirectory), { recursive: true })
  writeFileSync(
    join(workspaceRoot, relativeDirectory, 'project.json'),
    JSON.stringify({ name, projectType: 'application', targets: {} })
  )
}

/** Reads a generated project.json back. */
function readProjectJson(relativeDirectory: string): {
  targets: Record<string, { executor?: string; options?: Record<string, unknown> }>
} {
  return JSON.parse(
    readFileSync(join(workspaceRoot, relativeDirectory, 'project.json'), 'utf8')
  ) as never
}

/** The argv of every `runNx` call, flattened for easy matching. */
function nxCalls(): string[][] {
  return mockRunNx.mock.calls.map(call => call[0] as string[])
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-add-go-'))
  mockRunShell.mockImplementation(() => 0)
  jest.spyOn(process, 'cwd').mockReturnValue(workspaceRoot)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  writeFileSync(join(workspaceRoot, 'nx.json'), '{}')
  writeFileSync(
    join(workspaceRoot, 'package.json'),
    JSON.stringify({ name: '@demo/source', devDependencies: {} })
  )
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

describe('runAdd go', () => {
  it('probes for Go and fails fast with an install hint when it is missing', async () => {
    mockRunShell.mockImplementation(command => (command === 'go' ? 1 : 0))

    await expect(runAdd('go-app', 'api', {})).rejects.toThrow(/Go not found.*go\.dev/s)
  })

  it('bootstraps a single root go.mod via init + convert-to-one-mod on the first add', async () => {
    seedProjectJson('apps/api', 'api')

    await runAdd('go-app', 'api', {})

    expect(mockRunShell).toHaveBeenCalledWith('go', ['version'], workspaceRoot)
    expect(mockRunShell).toHaveBeenCalledWith(
      'npm',
      ['install', '--save-dev', '@nx-go/nx-go', '--no-audit', '--no-fund'],
      workspaceRoot
    )

    // Order matters: convert-to-one-mod refuses once go.work has any `use` line,
    // so it must run straight after init and before the first project exists.
    const calls = nxCalls()
    const initIndex = calls.findIndex(argv => argv.includes('@nx-go/nx-go:init'))
    const convertIndex = calls.findIndex(argv => argv.includes('@nx-go/nx-go:convert-to-one-mod'))
    const generateIndex = calls.findIndex(argv => argv.includes('@nx-go/nx-go:application'))
    expect(initIndex).toBeGreaterThanOrEqual(0)
    expect(convertIndex).toBeGreaterThan(initIndex)
    expect(generateIndex).toBeGreaterThan(convertIndex)
  })

  it('skips the module bootstrap when a root go.mod already exists', async () => {
    writeFileSync(join(workspaceRoot, 'go.mod'), 'module demo\n\ngo 1.24\n')
    seedProjectJson('apps/api', 'api')

    await runAdd('go-app', 'api', {})

    const calls = nxCalls()
    expect(calls.some(argv => argv.includes('@nx-go/nx-go:init'))).toBe(false)
    expect(calls.some(argv => argv.includes('@nx-go/nx-go:convert-to-one-mod'))).toBe(false)
  })

  it('adds a Go app under apps/ with build, test, lint and package targets', async () => {
    seedProjectJson('apps/api', 'api')

    await runAdd('go-app', 'api', {})

    expect(mockRunNx).toHaveBeenCalledWith(
      [
        'g',
        '@nx-go/nx-go:application',
        'apps/api',
        '--name=api',
        '--tags=type:go-app',
        '--no-interactive',
      ],
      workspaceRoot
    )

    const { targets } = readProjectJson('apps/api')
    expect(targets.build.executor).toBe('@nx-go/nx-go:build')
    expect(targets.test.executor).toBe('@nx-go/nx-go:test')
    expect(targets.package.executor).toBe('nx:run-commands')
    // Basename is exactly `go-app-<name>` — CI turns it into the build tag.
    expect(JSON.stringify(targets.package)).toContain('dist/drop/go-app-api.zip')
  })

  it('wires a local `go run .` start target and the discoverable root scripts', async () => {
    seedProjectJson('apps/api', 'api')

    await runAdd('go-app', 'api', {})

    const { targets } = readProjectJson('apps/api')
    expect(targets.start).toMatchObject({
      executor: 'nx:run-commands',
      continuous: true,
      options: { command: 'go run .', cwd: 'apps/api' },
    })

    const rootManifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(rootManifest.scripts['api:build']).toBe('nx run api:build')
    expect(rootManifest.scripts['api:qa']).toBe('nx run api:lint && nx run api:test')
    expect(rootManifest.scripts['api:start']).toBe('nx run api:start')
  })

  it('builds into a dist DIRECTORY, not a bare file, so Nx can cache the output', async () => {
    seedProjectJson('apps/api', 'api')

    await runAdd('go-app', 'api', {})

    // Regression guard: the executor's default writes the binary as a bare
    // file at dist/apps/<name>. Declaring a file in `outputs` makes Nx's
    // output collection fail with ENOTDIR, which surfaced only once caching
    // was left on — so the binary goes one level deeper, inside a directory.
    const { targets } = readProjectJson('apps/api')
    expect(targets.build.options).toEqual({ outputPath: '../../dist/apps/api/api' })
    expect(JSON.stringify(targets.package)).toContain("addLocalFolder('dist/apps/api')")
  })

  it('pins the lint target to golangci-lint, not the executor default of `go fmt`', async () => {
    seedProjectJson('apps/api', 'api')

    await runAdd('go-app', 'api', {})

    const { targets } = readProjectJson('apps/api')
    expect(targets.lint.executor).toBe('@nx-go/nx-go:lint')
    expect(targets.lint.options).toEqual({ linter: 'golangci-lint', args: ['run'] })
  })

  it('warns but does not fail when golangci-lint is missing', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockRunShell.mockImplementation(command => (command === 'golangci-lint' ? 1 : 0))
    seedProjectJson('apps/api', 'api')

    await expect(runAdd('go-app', 'api', {})).resolves.not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('golangci-lint not found'))
  })

  it('adds a Go function app tagged separately, with its own drop basename', async () => {
    seedProjectJson('apps/handler', 'handler')

    await runAdd('go-function-app', 'handler', {})

    expect(mockRunNx).toHaveBeenCalledWith(
      expect.arrayContaining(['@nx-go/nx-go:application', '--tags=type:go-function-app']),
      workspaceRoot
    )
    const { targets } = readProjectJson('apps/handler')
    expect(JSON.stringify(targets.package)).toContain('dist/drop/go-function-app-handler.zip')

    // No `start` target: there is no Azure Functions custom-handler wiring
    // for Go yet, so `func start` would just fail — a known gap, not a script.
    expect(targets.start).toBeUndefined()
    const rootManifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(rootManifest.scripts['handler:build']).toBe('nx run handler:build')
    expect(rootManifest.scripts['handler:start']).toBeUndefined()
  })

  it('adds a publishable Go lib under packages/ with test and lint but no build or publish target', async () => {
    writeFileSync(join(workspaceRoot, 'go.mod'), 'module demo\n\ngo 1.24\n')
    seedProjectJson('packages/core', 'core')

    await runAdd('go-lib', 'core', {})

    expect(mockRunNx).toHaveBeenCalledWith(
      [
        'g',
        '@nx-go/nx-go:library',
        'packages/core',
        '--name=core',
        '--tags=type:go-lib',
        '--no-interactive',
      ],
      workspaceRoot
    )

    const { targets } = readProjectJson('packages/core')
    expect(Object.keys(targets).toSorted((a, b) => a.localeCompare(b))).toEqual(['lint', 'test'])
    // Go publishing is a git tag, not a registry upload — there is nothing to push.
    expect(targets['nx-release-publish']).toBeUndefined()
  })

  it('adds an internal Go lib under libs/', async () => {
    writeFileSync(join(workspaceRoot, 'go.mod'), 'module demo\n\ngo 1.24\n')
    seedProjectJson('libs/util', 'util')

    await runAdd('go-internal-lib', 'util', {})

    expect(mockRunNx).toHaveBeenCalledWith(
      [
        'g',
        '@nx-go/nx-go:library',
        'libs/util',
        '--name=util',
        '--tags=type:go-internal-lib',
        '--no-interactive',
      ],
      workspaceRoot
    )
    expect(
      Object.keys(readProjectJson('libs/util').targets).toSorted((a, b) => a.localeCompare(b))
    ).toEqual(['lint', 'test'])
  })

  it('honours MNCI_NX_GO_SPEC so e2e can redirect the plugin install', async () => {
    process.env.MNCI_NX_GO_SPEC = '/tmp/nx-go.tgz'
    seedProjectJson('apps/api', 'api')

    try {
      await runAdd('go-app', 'api', {})
      expect(mockRunShell).toHaveBeenCalledWith(
        ['npm', 'install', '--save-dev', '/tmp/nx-go.tgz', '--no-audit', '--no-fund'][0],
        ['install', '--save-dev', '/tmp/nx-go.tgz', '--no-audit', '--no-fund'],
        workspaceRoot
      )
    } finally {
      delete process.env.MNCI_NX_GO_SPEC
    }
  })
})
