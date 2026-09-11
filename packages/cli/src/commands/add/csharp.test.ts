jest.mock('../../nx', () => ({
  runNx:        jest.fn(),
  runFormatter: jest.fn(),
  runShell:     jest.fn(() => 0),
}))
jest.mock('../../prompts', () => ({ promptText: jest.fn() }))
jest.mock('@inquirer/prompts', () => ({ select: jest.fn(), input: jest.fn() }))

import { select } from '@inquirer/prompts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

/**
 * The real repo's `node_modules`, five levels up from this file
 * (`commands/add/ -> commands -> src -> cli -> packages -> repo root`).
 *
 * @remarks
 * `tools/csharp-version-actions.cjs` `require()`s `nx/release`, exactly as
 * it will inside a real generated workspace. This test's workspace is a
 * throwaway `mkdtempSync` directory with no `node_modules` of its own, so a
 * symlink borrows the real one rather than mocking `nx/release` away — the
 * point of the test is that the real base class resolves and behaves.
 */
const repoNodeModules = join(__dirname, '..', '..', '..', '..', '..', 'node_modules')

/** Symlinks the real repo's `node_modules` into a throwaway workspace so `require('nx/release')` resolves. @param root - The throwaway workspace root. */
function linkRealNodeModules (root: string): void {
  symlinkSync(repoNodeModules, join(root, 'node_modules'), 'junction')
}

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

/**
 * Fakes `dotnet new`'s one filesystem side effect the real code now depends
 * on: `addCsharpLib` reads the freshly scaffolded `.csproj` back
 * (`addInitialVersion`) to inject a starting `<Version>`, so a mock that
 * only returns an exit code — true of every other kind here — leaves that
 * read hitting a file that was never written.
 */
function fakeDotnetNew (command: string, args: string[], cwd: string): number {
  if (command === 'dotnet' && args[0] === 'new') {
    const identity = args[args.indexOf('-n') + 1]
    const outDir = args[args.indexOf('-o') + 1]
    mkdirSync(join(cwd, outDir), { recursive: true })
    writeFileSync(
      join(cwd, outDir, `${identity}.csproj`),
      '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n  </PropertyGroup>\n</Project>\n',
    )
  }

  return 0
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-add-csharp-'))
  mockRunShell.mockImplementation(fakeDotnetNew)
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

  it('fails with a clear error when dotnet new itself exits non-zero (SDK present, scaffold failed)', async () => {
    mockRunShell.mockImplementation((command, args) =>
      command === 'dotnet' && args[0] === 'new' ? 1 : 0,
    )

    await expect(runAdd('csharp-app', 'api', {})).rejects.toThrow('dotnet new console failed for apps/api')
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

  it('starts the .csproj at an explicit 0.1.0, since dotnet new writes no <Version> at all', async () => {
    await runAdd('csharp-lib', 'sdk', {})

    const csproj = readFileSync(join(workspaceRoot, 'packages/sdk/Demo.Sdk.csproj'), 'utf8')
    expect(csproj).toContain('<Version>0.1.0</Version>')
  })

  it('points project.json at the shared tools/csharp-version-actions.cjs for nx release', async () => {
    await runAdd('csharp-lib', 'sdk', {})

    const project = readProjectJson('packages/sdk') as unknown as {
      release?: { version?: { versionActions?: string } }
    }
    expect(project.release?.version?.versionActions).toBe('tools/csharp-version-actions.cjs')
    expect(existsSync(join(workspaceRoot, 'tools/csharp-version-actions.cjs'))).toBe(true)
  })

  it('re-adding the same lib merges into the existing project.json rather than discarding it', async () => {
    // @nx/dotnet writes no project.json at all, so the FIRST add always
    // creates it fresh — this is the only path that exercises a SECOND add
    // finding one already there (e.g. a hand-added custom target) and
    // merging into it instead of overwriting it.
    await runAdd('csharp-lib', 'sdk', {})
    const projectJsonPath = join(workspaceRoot, 'packages/sdk/project.json')
    const existing = JSON.parse(readFileSync(projectJsonPath, 'utf8')) as Record<string, unknown>
    writeFileSync(
      projectJsonPath,
      JSON.stringify({ ...existing, targets: { ...(existing.targets as object), custom: { executor: 'nx:noop' } } }),
    )

    await runAdd('csharp-lib', 'sdk', {})

    const project = readProjectJson('packages/sdk') as unknown as {
      targets:  Record<string, unknown>
      release?: { version?: { versionActions?: string } }
    }
    expect(project.targets.custom).toEqual({ executor: 'nx:noop' })
    expect(project.release?.version?.versionActions).toBe('tools/csharp-version-actions.cjs')
  })

  it('adds an nx-release-publish target that packs then pushes to the fixed NUGET_AZURE_SOURCE key', async () => {
    await runAdd('csharp-lib', 'sdk', {})

    const { targets } = readProjectJson('packages/sdk')
    const publish = targets['nx-release-publish']
    expect(publish.executor).toBe('nx:run-commands')
    const command = String(publish.options?.command)
    expect(command).toContain("'pack','packages/sdk'")
    expect(command).toContain("'nuget','push'")
    expect(command).toContain("'--source','AzureArtifacts'")
    // Self-gates at RUNTIME on NUGET_PAT rather than being generated
    // differently per registry — the target itself carries no registry
    // specifics, matching Python's nx-release-publish target.
    expect(command).toContain('process.env.NUGET_PAT')
  })

  it('writes a public-registry nuget.config (no credentials) by default', async () => {
    await runAdd('csharp-lib', 'sdk', {})

    const config = readFileSync(join(workspaceRoot, 'nuget.config'), 'utf8')
    expect(config).toContain('nuget.org')
    expect(config).not.toContain('packageSourceCredentials')
  })

  it('writes an Azure Artifacts nuget.config when the workspace was generated with that registry', async () => {
    writeFileSync(
      join(workspaceRoot, 'nx.json'),
      JSON.stringify({
        mnci: {
          registry: {
            kind:          'azure-artifacts',
            organization:  'org',
            project:       'proj',
            artifactsFeed: 'feed',
          },
        },
      }),
    )

    await runAdd('csharp-lib', 'sdk', {})

    const config = readFileSync(join(workspaceRoot, 'nuget.config'), 'utf8')
    expect(config).toContain('AzureArtifacts')
    expect(config).toContain('_packaging/feed/nuget/v3/index.json')
    expect(config).toContain('%NUGET_PAT%')
  })

  it('writes a CsharpVersionActions that reads/writes a .csproj <Version> and validates its presence', async () => {
    // A real integration check, not a string-content assertion: `require()`
    // the exact file mnci writes into a generated workspace and exercise it
    // against a minimal fake Tree, the same way nx release actually drives
    // it (see resolveVersionActionsForProject in nx's own source).
    await runAdd('csharp-lib', 'sdk', {})
    linkRealNodeModules(workspaceRoot)

    const csprojPath = join(workspaceRoot, 'packages/sdk/Demo.Sdk.csproj')
    writeFileSync(
      csprojPath,
      '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <Version>1.2.3</Version>\n  </PropertyGroup>\n</Project>\n',
    )

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require of a generated-workspace file, mirroring how nx release itself loads it.
    const CsharpVersionActions = require(join(workspaceRoot, 'tools/csharp-version-actions.cjs')) as new (
      ...arguments_: unknown[]
    ) => {
      validate:                             (tree: unknown) => Promise<void>
      readCurrentVersionFromSourceManifest: (
        tree: unknown,
      ) => Promise<{ currentVersion: string; manifestPath: string } | null>
      readCurrentVersionFromRegistry: (
        tree: unknown,
        metadata: unknown,
      ) => Promise<{ currentVersion: string | null; logText: string }>
      updateProjectVersion: (tree: unknown, newVersion: string) => Promise<string[]>
    }

    const fakeTree = {
      children: (dir: string) => (dir.endsWith('sdk') ? ['Demo.Sdk.csproj'] : []),
      read:     (path: string) => (path.includes('Demo.Sdk.csproj') ? readFileSync(csprojPath, 'utf8') : null),
      write:    (path: string, contents: string) => {
        if (path.includes('Demo.Sdk.csproj')) writeFileSync(csprojPath, contents)
      },
      exists: (path: string) => path.includes('Demo.Sdk.csproj'),
    }

    const instance = new CsharpVersionActions(
      {},
      { name: 'sdk', data: { root: 'packages/sdk' } },
      {},
    )

    await expect(instance.readCurrentVersionFromSourceManifest(fakeTree)).resolves.toEqual({
      currentVersion: '1.2.3',
      manifestPath:   'packages/sdk/Demo.Sdk.csproj',
    })

    const registryResult = await instance.readCurrentVersionFromRegistry(fakeTree, undefined)
    expect(registryResult.currentVersion).toBeNull()
    expect(registryResult.logText).toContain('git tag')

    await expect(instance.validate(fakeTree)).resolves.toBeUndefined()

    await instance.updateProjectVersion(fakeTree, '1.3.0')
    expect(readFileSync(csprojPath, 'utf8')).toContain('<Version>1.3.0</Version>')
  })

  it('validate() throws when no .csproj exists at all, catching a project with a missing manifest', async () => {
    await runAdd('csharp-lib', 'sdk', {})
    linkRealNodeModules(workspaceRoot)

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require of a generated-workspace file, mirroring how nx release itself loads it.
    const CsharpVersionActions = require(join(workspaceRoot, 'tools/csharp-version-actions.cjs')) as new (
      ...arguments_: unknown[]
    ) => { validate: (tree: unknown) => Promise<void> }

    const emptyTree = { children: () => [] }
    const instance = new CsharpVersionActions({}, { name: 'sdk', data: { root: 'packages/sdk' } }, {})

    await expect(instance.validate(emptyTree)).rejects.toThrow(/does not have a \.csproj file/)
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

describe('runAdd csharp-function-app', () => {
  it('scaffolds via the base console template, then overlays the isolated-worker shape', async () => {
    await runAdd('csharp-function-app', 'api', {})

    // Same base scaffold as csharp-app, matching addNodeFunctionApp's
    // "generate the plain app, then overlay" split.
    expect(shellCalls('dotnet')).toContainEqual([
      'new',
      'console',
      '-n',
      'Api',
      '-o',
      'apps/api',
      '--framework',
      'net10.0',
    ])

    const csproj = readFileSync(join(workspaceRoot, 'apps/api/Api.csproj'), 'utf8')
    expect(csproj).toContain('Sdk="Azure.Functions.Sdk/1.0.0"')
    expect(csproj).toContain('Microsoft.Azure.Functions.Worker.Extensions.Http.AspNetCore')

    const program = readFileSync(join(workspaceRoot, 'apps/api/Program.cs'), 'utf8')
    expect(program).toContain('FunctionsApplication.CreateBuilder')
    expect(program).toContain('ConfigureFunctionsWebApplication')

    const hello = readFileSync(join(workspaceRoot, 'apps/api/Hello.cs'), 'utf8')
    expect(hello).toContain('namespace Api;')
    expect(hello).toContain('[Function("Hello")]')
    expect(hello).toContain('[HttpTrigger(AuthorizationLevel.Anonymous, "get")]')

    expect(readFileSync(join(workspaceRoot, 'apps/api/host.json'), 'utf8')).toContain(
      'extensionBundle',
    )
  })

  it('adds a package target zipping the isolated-worker publish output, and a dotnet run start target', async () => {
    await runAdd('csharp-function-app', 'api', {})

    const { targets } = readProjectJson('apps/api')
    expect(targets.package.executor).toBe('nx:run-commands')
    const command = String(targets.package.options?.command)
    expect(command).toContain('dist/drop/csharp-function-app-api.zip')
    expect(targets.start).toMatchObject({
      executor:   'nx:run-commands',
      continuous: true,
      options:    { command: 'dotnet run', cwd: 'apps/api' },
    })
  })

  it('never scopes it with a PackageId prefix — a function app is never NuGet-published', async () => {
    await runAdd('csharp-function-app', 'api', {})

    expect(shellCalls('dotnet')).not.toContainEqual(
      expect.arrayContaining(['-n', expect.stringContaining('Demo.')]),
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
