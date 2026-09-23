// Neither the interpreter nor the cwd is hardcoded here, for the reasons
// `lint/executor.spec.ts` sets out at length: `pythonCommand()` because POSIX
// registers `python3` while the python.org Windows installer registers only
// `python.exe` (that mapping is pinned independently in
// `internal/python-command.algorithm.spec.ts`), and `join()` because the cwd is
// a REAL filesystem path handed to spawn, so asserting the POSIX spelling
// would assert a platform rather than a behaviour.
import type { ExecutorContext } from '@nx/devkit'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pythonCommand } from '../../internal/python-command.algorithm'
import typecheckExecutor from './executor'

jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }))

const mockSpawnSync = jest.mocked(spawnSync)

function context (): ExecutorContext {
  return {
    root:                   '/workspace',
    projectName:            'svc',
    cwd:                    '/workspace',
    isVerbose:              false,
    projectsConfigurations: {
      version:  2,
      projects: { svc: { root: 'apps/svc' } },
    },
  } as unknown as ExecutorContext
}

describe('typecheckExecutor', () => {
  afterEach(() => jest.resetAllMocks())

  it('runs mypy in the project directory, with no flags', async () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    const result = await typecheckExecutor({}, context())

    expect(result).toEqual({ success: true })
    /*
     * No flags, deliberately. The strictness lives in the project's own
     * `pyproject.toml`, so a developer running `python -m mypy .` by hand from
     * the project directory gets exactly what the target gets. A flag-driven
     * target is how "it passes in CI but not for me" starts.
     */
    expect(mockSpawnSync).toHaveBeenCalledWith(pythonCommand(), ['-m', 'mypy', '.'], {
      cwd:   join('/workspace', 'apps/svc'),
      stdio: 'inherit',
    })
  })

  it('reports failure when mypy exits non-zero', async () => {
    mockSpawnSync.mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>)

    expect(await typecheckExecutor({}, context())).toEqual({ success: false })
  })
})
