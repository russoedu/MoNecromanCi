jest.mock('../../nx', () => ({
  runNx:        jest.fn(),
  runFormatter: jest.fn(),
  runShell:     jest.fn(() => 0),
}))
jest.mock('../../prompts', () => ({ promptText: jest.fn() }))
jest.mock('@inquirer/prompts', () => ({ select: jest.fn(), input: jest.fn() }))

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runNx, runShell } from '../../nx'
import { runAdd } from '../add'

const mockRunNx = jest.mocked(runNx)
const mockRunShell = jest.mocked(runShell)

let workspaceRoot: string

/** Reads a generated project.json back. */
function readProjectJson (relativeDirectory: string): {
  targets: Record<string, { executor?: string; options?: Record<string, unknown> }>
} {
  return JSON.parse(
    readFileSync(join(workspaceRoot, relativeDirectory, 'project.json'), 'utf8'),
  ) as never
}

/** The argv of every `runShell` call whose command matches. @param command - The command name to filter on. */
function shellCalls (command: string): string[][] {
  return mockRunShell.mock.calls.filter(call => call[0] === command).map(call => call[1])
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-add-csharp-'))
  mockRunShell.mockImplementation(() => 0)
  jest.spyOn(process, 'cwd').mockReturnValue(workspaceRoot)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  writeFileSync(join(workspaceRoot, 'nx.json'), '{}')
  writeFileSync(
    join(workspaceRoot, 'package.json'),
    JSON.stringify({ name: '@demo/source', devDependencies: {} }),
  )
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

describe('runAdd csharp-app', () => {
  it('probes for the .NET SDK and fails fast with an install hint when it is missing', async () => {
    mockRunShell.mockImplementation(command => (command === 'dotnet' ? 1 : 0))

    await expect(runAdd('csharp-app', 'api', {})).rejects.toThrow(/\.NET SDK not found.*dotnet\.microsoft\.com/s)
  })

  it('probes the SDK, then installs the @nx/dotnet plugin on first use via nx add', async () => {
    await runAdd('csharp-app', 'api', {})

    expect(mockRunShell).toHaveBeenCalledWith('dotnet', ['--version'], workspaceRoot)
    expect(mockRunNx).toHaveBeenCalledWith(['add', '@nx/dotnet'], workspaceRoot)
  })

  it('skips the plugin install when it is already a devDependency', async () => {
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: 'demo', devDependencies: { '@nx/dotnet': '^23.0.0' } }),
    )

    await runAdd('csharp-app', 'api', {})

    expect(mockRunNx).not.toHaveBeenCalled()
  })

  it('scaffolds a console app with the real dotnet CLI, PascalCase name, pinned TFM', async () => {
    await runAdd('csharp-app', 'web-api', {})

    expect(shellCalls('dotnet')).toContainEqual([
      'new',
      'console',
      '-n',
      'WebApi',
      '-o',
      'apps/web-api',
      '--framework',
      'net10.0',
    ])
  })

  it('adds a package target that publishes then zips into the drop', async () => {
    await runAdd('csharp-app', 'api', {})

    const { targets } = readProjectJson('apps/api')
    expect(targets.package.executor).toBe('nx:run-commands')
    const command = String(targets.package.options?.command)
    expect(command).toContain("'publish','apps/api'")
    expect(command).toContain('dist/drop/csharp-app-api.zip')
  })

  it('wires a local `dotnet run` start target and the discoverable root scripts', async () => {
    await runAdd('csharp-app', 'api', {})

    const { targets } = readProjectJson('apps/api')
    expect(targets.start).toMatchObject({
      executor:   'nx:run-commands',
      continuous: true,
      options:    { command: 'dotnet run', cwd: 'apps/api' },
    })

    const rootManifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(rootManifest.scripts['api:build']).toBe('nx run api:build')
    expect(rootManifest.scripts['api:qa']).toBe('nx run api:lint && nx run api:test')
    expect(rootManifest.scripts['api:start']).toBe('nx run api:start')
  })
})
