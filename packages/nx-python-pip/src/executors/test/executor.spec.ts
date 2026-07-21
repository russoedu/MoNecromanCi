import type { ExecutorContext } from '@nx/devkit'
import { spawnSync } from 'node:child_process'
import testExecutor from './executor'

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

describe('testExecutor', () => {
  afterEach(() => jest.resetAllMocks())

  it('installs the project in editable mode before pytest by default', async () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    const result = await testExecutor({}, context())

    expect(result).toEqual({ success: true })
    expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'python3', ['-m', 'pip', 'install', '--quiet', '-e', '.'], { cwd: '/workspace/apps/svc', stdio: 'inherit' })
    expect(mockSpawnSync).toHaveBeenNthCalledWith(2, 'python3', ['-m', 'pytest'], { cwd: '/workspace/apps/svc', stdio: 'inherit' })
  })

  it('skips the editable install when installEditable is false (function apps, no pyproject.toml)', async () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    await testExecutor({ installEditable: false }, context())

    expect(mockSpawnSync).toHaveBeenCalledTimes(1)
    expect(mockSpawnSync).toHaveBeenCalledWith('python3', ['-m', 'pytest'], { cwd: '/workspace/apps/svc', stdio: 'inherit' })
  })

  it('fails fast when the editable install fails, without running pytest', async () => {
    mockSpawnSync.mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>)

    const result = await testExecutor({}, context())

    expect(result).toEqual({ success: false })
    expect(mockSpawnSync).toHaveBeenCalledTimes(1)
  })

  it('reports failure when pytest itself exits non-zero', async () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>)

    expect(await testExecutor({}, context())).toEqual({ success: false })
  })
})
