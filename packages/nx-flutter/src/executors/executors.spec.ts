jest.mock('node:child_process', () => ({ spawnSync: jest.fn(() => ({ status: 0 })) }))

import { spawnSync } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
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
  it('resolves the workspace-relative outputPath to an ABSOLUTE path for flutter', async () => {
    // The target declares `dist/apps/web` (workspace-relative, matching its Nx
    // `outputs` token). It must reach flutter absolute.
    //
    // These two tests previously asserted the opposite — `../../dist/apps/web` —
    // and that relative form is the bug. flutter passes `--output` through to
    // `impellerc`, the shader compiler it spawns, which does not run with the
    // cwd set here; the two then resolve the same relative string against
    // different directories. The Dart bundle compiles, then asset copying dies
    // with `Could not write file to "..\..\dist\apps\hello\assets\shaders/
    // ink_sparkle.frag"`. Upstream: flutter/flutter#148542 and #157886, and
    // every report shares the relative `--output`.
    const result = await buildExecutor(
      { outputPath: 'dist/apps/web' },
      contextFor('/ws', 'apps/web')
    )

    expect(result).toEqual({ success: true })
    const { command, argv, cwd } = spawnArguments()
    expect(command).toBe('flutter')
    expect(argv).toEqual(['build', 'web', '--output', join('/ws', 'dist/apps/web')])
    expect(cwd).toBe(join('/ws', 'apps/web'))
  })

  it('passes an absolute --output at every project depth, never a `..` path', async () => {
    // The regression guard, asserted as a property rather than on one fixture:
    // the old code produced a different number of `../` segments per depth, so a
    // single-path assertion is exactly what let the shape look intentional.
    for (const projectRoot of ['apps/web', 'apps/nested/web', 'apps/a/b/c/web']) {
      mockSpawnSync.mockClear()
      await buildExecutor({ outputPath: 'dist/apps/web' }, contextFor('/ws', projectRoot))

      const output = spawnArguments().argv.at(-1) as string

      expect(isAbsolute(output)).toBe(true)
      expect(output).not.toContain('..')
      expect(output).toBe(join('/ws', 'dist/apps/web'))
    }
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
