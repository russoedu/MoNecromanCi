// Two things here are deliberately NOT hardcoded, because hardcoding either one
// makes this suite pass on Linux and fail on Windows — which is exactly what it
// did:
//
//   - the interpreter, via `pythonCommand()`. POSIX registers `python3`; the
//     python.org Windows installer registers only `python.exe`. That mapping is
//     pinned independently in `internal/pythonCommand.spec.ts`, so using the
//     helper here asserts "the executor calls the platform's interpreter"
//     rather than restating the mapping.
//   - the cwd, via `join()`. It is a REAL filesystem path handed to spawn, so
//     it is correctly back-slashed on Windows; asserting the POSIX spelling
//     asserts a platform, not a behaviour.
import type { ExecutorContext } from '@nx/devkit'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pythonCommand } from '../../internal/pythonCommand'
import lintExecutor from './executor'

jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }))

const mockSpawnSync = jest.mocked(spawnSync)

function context (): ExecutorContext {
  return {
    root: '/workspace',
    projectName: 'svc',
    cwd: '/workspace',
    isVerbose: false,
    projectsConfigurations: {
      version: 2,
      projects: { svc: { root: 'apps/svc' } }
    }
  } as unknown as ExecutorContext
}

describe('lintExecutor', () => {
  afterEach(() => jest.resetAllMocks())

  it('runs ruff check . in the project directory', async () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    const result = await lintExecutor({}, context())

    expect(result).toEqual({ success: true })
    expect(mockSpawnSync).toHaveBeenCalledWith(pythonCommand(), ['-m', 'ruff', 'check', '.'], {
      cwd: join('/workspace', 'apps/svc'),
      stdio: 'inherit'
    })
  })

  it('reports failure when ruff exits non-zero', async () => {
    mockSpawnSync.mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>)

    expect(await lintExecutor({}, context())).toEqual({ success: false })
  })
})
