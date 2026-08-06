jest.mock('../../nx', () => ({
  runNx: jest.fn(),
  runFormatter: jest.fn(),
  runShell: jest.fn(() => 0)
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

/** The argv of every `runNx` call, flattened for easy matching. */
function nxCalls(): string[][] {
  return mockRunNx.mock.calls.map(call => call[0])
}

/** Pre-creates the `project.json` the (mocked) plugin's app generator would write. */
function seedProjectJson(relativeDirectory: string, name: string): void {
  mkdirSync(join(workspaceRoot, relativeDirectory), { recursive: true })
  writeFileSync(
    join(workspaceRoot, relativeDirectory, 'project.json'),
    JSON.stringify({ name, projectType: 'application', targets: { build: {} } })
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

/** The command+argv of every `runShell` call. */
function shellCalls(): string[] {
  return mockRunShell.mock.calls.map(call => `${call[0]} ${call[1].join(' ')}`)
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-add-flutter-'))
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

describe('runAdd flutter', () => {
  it('probes for the Flutter SDK and fails fast with an install hint when it is missing', async () => {
    mockRunShell.mockImplementation(command => (command === 'flutter' ? 1 : 0))

    await expect(runAdd('flutter-app', 'web', {})).rejects.toThrow(
      /Flutter not found.*docs\.flutter\.dev/s
    )
    // Nothing should have been generated once the toolchain probe failed.
    expect(mockRunNx).not.toHaveBeenCalled()
  })

  it('installs the plugin then delegates the app to its application generator', async () => {
    seedProjectJson('apps/web', 'web')

    await runAdd('flutter-app', 'web', {})

    expect(mockRunShell).toHaveBeenCalledWith('flutter', ['--version'], workspaceRoot)
    expect(mockRunShell).toHaveBeenCalledWith(
      'npm',
      ['install', '--save-dev', '@mnci/nx-flutter', '--no-audit', '--no-fund'],
      workspaceRoot
    )
    expect(mockRunNx).toHaveBeenCalledWith(
      ['g', '@mnci/nx-flutter:application', 'web', '--no-interactive'],
      workspaceRoot
    )
  })

  it("installs adm-zip for an app (the zip-into-drop convention is mnci's, not the plugin's)", async () => {
    seedProjectJson('apps/web', 'web')

    await runAdd('flutter-app', 'web', {})

    expect(shellCalls()).toContain('npm install --save-dev adm-zip --no-audit --no-fund')
  })

  it('wires a local `flutter run -d chrome` start target and the discoverable root scripts', async () => {
    seedProjectJson('apps/web', 'web')

    await runAdd('flutter-app', 'web', {})

    const project = readProjectJson('apps/web')
    expect(project.targets.start).toMatchObject({
      executor: 'nx:run-commands',
      continuous: true,
      options: { command: 'flutter run -d chrome', cwd: 'apps/web' }
    })
    // build survives from the seeded fixture — this call only adds 'start'.
    expect(project.targets.build).toBeDefined()

    const rootManifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(rootManifest.scripts['web:build']).toBe('nx run web:build')
    expect(rootManifest.scripts['web:qa']).toBe('nx run web:lint && nx run web:test')
    expect(rootManifest.scripts['web:start']).toBe('nx run web:start')
  })

  it('registers only build/qa (no start) for a publishable lib — a Dart package has no dev server', async () => {
    await runAdd('flutter-lib', 'shared', {})

    const rootManifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(rootManifest.scripts['shared:qa']).toBe('nx run shared:lint && nx run shared:test')
    expect(rootManifest.scripts['shared:build']).toBeUndefined()
    expect(rootManifest.scripts['shared:start']).toBeUndefined()
  })

  it('does not install adm-zip for a library — a Dart package is never packed into the drop', async () => {
    await runAdd('flutter-lib', 'shared', {})

    expect(shellCalls().some(call => call.includes('adm-zip'))).toBe(false)
  })

  it('delegates a publishable lib to the library generator', async () => {
    await runAdd('flutter-lib', 'shared', {})

    expect(mockRunNx).toHaveBeenCalledWith(
      ['g', '@mnci/nx-flutter:library', 'shared', '--no-interactive'],
      workspaceRoot
    )
  })

  it('delegates a private lib to the internal-library generator', async () => {
    await runAdd('flutter-internal-lib', 'core', {})

    expect(mockRunNx).toHaveBeenCalledWith(
      ['g', '@mnci/nx-flutter:internal-library', 'core', '--no-interactive'],
      workspaceRoot
    )
  })

  it('skips the plugin install when it is already a devDependency', async () => {
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: '@demo/source', devDependencies: { '@mnci/nx-flutter': '^0.1.0' } })
    )

    await runAdd('flutter-lib', 'shared', {})

    expect(shellCalls().some(call => call.includes('@mnci/nx-flutter'))).toBe(false)
    // …but generation still happens.
    expect(nxCalls().some(argv => argv.includes('@mnci/nx-flutter:library'))).toBe(true)
  })

  it('honours MNCI_NX_FLUTTER_SPEC so e2e can install a locally packed tarball', async () => {
    process.env.MNCI_NX_FLUTTER_SPEC = '/tmp/nx-flutter.tgz'

    try {
      await runAdd('flutter-lib', 'shared', {})
      expect(mockRunShell).toHaveBeenCalledWith(
        'npm',
        ['install', '--save-dev', '/tmp/nx-flutter.tgz', '--no-audit', '--no-fund'],
        workspaceRoot
      )
    } finally {
      delete process.env.MNCI_NX_FLUTTER_SPEC
    }
  })

  it('fails loudly when the plugin install itself fails', async () => {
    mockRunShell.mockImplementation((command, arguments_) =>
      command === 'npm' && arguments_.includes('@mnci/nx-flutter') ? 1 : 0
    )

    await expect(runAdd('flutter-lib', 'shared', {})).rejects.toThrow(
      'npm install of @mnci/nx-flutter failed'
    )
  })
})
