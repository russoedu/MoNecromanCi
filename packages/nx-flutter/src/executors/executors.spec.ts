jest.mock('node:child_process', () => ({ spawnSync: jest.fn(() => ({ status: 0 })) }))

import { spawnSync } from 'node:child_process'
import type { ExecutorContext } from '@nx/devkit'
import buildExecutor from './build/executor'
import lintExecutor from './lint/executor'
import testExecutor from './test/executor'

const mockSpawnSync = jest.mocked(spawnSync)

/** A context shaped like the one Nx passes a target invocation. */
function contextFor(root: string, projectRoot: string): ExecutorContext {
  return {
    root,
    projectName: 'web',
    projectsConfigurations: { version: 2, projects: { web: { root: projectRoot } } }
  } as unknown as ExecutorContext
}

/** The argv of the single spawnSync call. */
function spawnArguments(): { command: string; argv: string[]; cwd: string } {
  const [command, argv, options] = mockSpawnSync.mock.calls[0] as [
    string,
    string[],
    { cwd: string }
  ]
  return { command, argv, cwd: options.cwd }
}

beforeEach(() => {
  mockSpawnSync.mockReturnValue({ status: 0 } as never)
})

describe('lint executor', () => {
  it('runs flutter analyze in the project directory with info issues pinned fatal', async () => {
    const result = await lintExecutor({}, contextFor('/ws', 'apps/web'))

    expect(result).toEqual({ success: true })
    const { command, argv, cwd } = spawnArguments()
    expect(command).toBe('flutter')
    // --fatal-infos is redundant against the current default but pinned so the
    // gate cannot silently weaken if that default ever changes.
    expect(argv).toEqual(['analyze', '--fatal-infos'])
    expect(cwd).toBe('/ws/apps/web')
  })

  it('reports failure when the analyser exits non-zero', async () => {
    mockSpawnSync.mockReturnValue({ status: 1 } as never)

    await expect(lintExecutor({}, contextFor('/ws', 'apps/web'))).resolves.toEqual({
      success: false
    })
  })
})

describe('test executor', () => {
  it('runs flutter test in the project directory', async () => {
    const result = await testExecutor({}, contextFor('/ws', 'libs/core'))

    expect(result).toEqual({ success: true })
    const { command, argv, cwd } = spawnArguments()
    expect(command).toBe('flutter')
    expect(argv).toEqual(['test'])
    expect(cwd).toBe('/ws/libs/core')
  })

  it('reports failure when the test run exits non-zero', async () => {
    mockSpawnSync.mockReturnValue({ status: 1 } as never)

    await expect(testExecutor({}, contextFor('/ws', 'libs/core'))).resolves.toEqual({
      success: false
    })
  })
})

describe('build executor', () => {
  it('converts the workspace-relative outputPath into one relative to the project', async () => {
    // The target declares `dist/apps/web` (workspace-relative, matching its Nx
    // `outputs` token), but flutter resolves --output against its own cwd — the
    // project directory — so it must arrive as `../../dist/apps/web`.
    const result = await buildExecutor(
      { outputPath: 'dist/apps/web' },
      contextFor('/ws', 'apps/web')
    )

    expect(result).toEqual({ success: true })
    const { command, argv, cwd } = spawnArguments()
    expect(command).toBe('flutter')
    expect(argv).toEqual(['build', 'web', '--output', '../../dist/apps/web'])
    expect(cwd).toBe('/ws/apps/web')
  })

  it('handles a deeper project root', async () => {
    await buildExecutor({ outputPath: 'dist/apps/web' }, contextFor('/ws', 'apps/nested/web'))

    expect(spawnArguments().argv).toEqual(['build', 'web', '--output', '../../../dist/apps/web'])
  })

  it('reports failure when the build exits non-zero', async () => {
    mockSpawnSync.mockReturnValue({ status: 1 } as never)

    await expect(
      buildExecutor({ outputPath: 'dist/apps/web' }, contextFor('/ws', 'apps/web'))
    ).resolves.toEqual({ success: false })
  })
})

describe('project-root resolution', () => {
  it('throws a diagnosable error when the context has no resolvable project', async () => {
    const broken = { root: '/ws', projectName: undefined } as unknown as ExecutorContext

    await expect(lintExecutor({}, broken)).rejects.toThrow(/Could not resolve the project root/)
  })
})
