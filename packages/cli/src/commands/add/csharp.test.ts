jest.mock('../../nx', () => ({
  runNx:        jest.fn(),
  runFormatter: jest.fn(),
  runShell:     jest.fn(() => 0),
}))
jest.mock('../../prompts', () => ({ promptText: jest.fn() }))
jest.mock('@inquirer/prompts', () => ({ select: jest.fn(), input: jest.fn() }))

import { select } from '@inquirer/prompts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { runNx, runShell } from '../../nx'
import { githubActionsYaml } from '../../overlay'
import { promptText } from '../../prompts'
import { runAdd } from '../add'

const mockRunNx = jest.mocked(runNx)
const mockRunShell = jest.mocked(runShell)
const mockSelect = jest.mocked(select)
const mockPromptText = jest.mocked(promptText)

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

describe('runAdd csharp-lib', () => {
  it('scaffolds a NuGet-publishable class library under packages/, PackageId scoped', async () => {
    await runAdd('csharp-lib', 'sdk', {})

    expect(shellCalls('dotnet')).toContainEqual([
      'new',
      'classlib',
      '-n',
      'Demo.Sdk',
      '-o',
      'packages/sdk',
      '--framework',
      'net10.0',
    ])
  })

  it('folds a multi-word scope into PascalCase, matching the NuGet dotted convention', async () => {
    await runAdd('csharp-lib', 'sdk', { scope: '@my-org' })

    expect(shellCalls('dotnet')).toContainEqual(
      expect.arrayContaining(['-n', 'MyOrg.Sdk']),
    )
  })

  it('does not prompt for scope on the flag path (kind passed) — defaults it silently', async () => {
    await runAdd('csharp-lib', 'sdk', {})

    expect(mockPromptText).not.toHaveBeenCalled()
  })

  it('prompts for the scope on the interactive path (kind not passed)', async () => {
    mockSelect.mockResolvedValue('csharp-lib')
    mockPromptText.mockResolvedValueOnce('sdk').mockResolvedValueOnce('@acme') // name, then scope

    await runAdd(undefined, undefined, {})

    expect(mockPromptText).toHaveBeenCalledWith(
      'NuGet package scope for the published library',
      '@demo',
    )
    expect(shellCalls('dotnet')).toContainEqual(
      expect.arrayContaining(['-n', 'Acme.Sdk']),
    )
  })

  it('registers root scripts, with no :start (a library has no local dev server)', async () => {
    await runAdd('csharp-lib', 'sdk', {})

    const rootManifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(rootManifest.scripts['sdk:build']).toBe('nx run sdk:build')
    expect(rootManifest.scripts['sdk:qa']).toBe('nx run sdk:lint && nx run sdk:test')
    expect(rootManifest.scripts['sdk:start']).toBeUndefined()
  })
})

describe('runAdd csharp-internal-lib', () => {
  it('scaffolds an unscoped class library under libs/ — never published, no PackageId prefix', async () => {
    await runAdd('csharp-internal-lib', 'util', {})

    expect(shellCalls('dotnet')).toContainEqual([
      'new',
      'classlib',
      '-n',
      'Util',
      '-o',
      'libs/util',
      '--framework',
      'net10.0',
    ])
  })

  it('registers no :build root script — an internal-only lib has none, matching go-internal-lib', async () => {
    await runAdd('csharp-internal-lib', 'util', {})

    const rootManifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(rootManifest.scripts['util:build']).toBeUndefined()
    expect(rootManifest.scripts['util:qa']).toBe('nx run util:lint && nx run util:test')
  })

  it('tells the user how to wire it into a consumer, since C# has no implicit resolution', async () => {
    const logged: string[] = []
    jest.spyOn(console, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message))
    })

    await runAdd('csharp-internal-lib', 'util', {})

    expect(logged.join('\n')).toContain(
      'dotnet add <consumer>.csproj reference libs/util/Util.csproj',
    )
  })
})

// Skipped on Windows for the same reason node.test.ts's equivalent suite is: a
// PATH stub for `npx` needs a `.cmd` shim under cmd.exe, and this platform's
// job here is the e2e, not these unit-level guard executions.
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe

describeOnPosix("the generated pipeline's pack-apps guard, run against a bare .csproj", () => {
  // csharp.ts's own add path always creates a project.json (so the guard's
  // pre-existing hasProjectJson branch already covers it), which is exactly
  // why this needs its OWN fixture: a .csproj with no project.json at all —
  // a user-authored one this CLI never generated — to actually exercise the
  // third detection branch rather than one already covered by the other two.
  it('is detected by the pack guard from the .csproj alone, with no project.json present', () => {
    mkdirSync(join(workspaceRoot, 'apps/api'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/api/Api.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />\n')

    const pipeline = githubActionsYaml('ubuntu-latest')
    const guard = (pipeline.match(/node -e "[^"]*"/g) ?? []).find(candidate =>
      candidate.includes('No apps to pack'),
    )
    expect(guard).toBeTruthy()

    const log = join(workspaceRoot, 'nx-command.log')
    mkdirSync(join(workspaceRoot, 'stub-bin'))
    writeFileSync(
      join(workspaceRoot, 'stub-bin/npx'),
      `#!/bin/sh\necho "$@" > "${log}"\nexit 0\n`,
      { mode: 0o755 },
    )

    const result = spawnSync(guard ?? '', {
      cwd:      workspaceRoot,
      shell:    true,
      encoding: 'utf8',
      env:      {
        ...process.env,
        PATH: `${join(workspaceRoot, 'stub-bin')}${delimiter}${process.env.PATH ?? ''}`,
      },
    })

    expect(result.stdout).not.toContain('No apps to pack')
    expect(existsSync(log)).toBe(true)
    expect(readFileSync(log, 'utf8').trim()).toBe('nx run-many -t package')
  })
})
