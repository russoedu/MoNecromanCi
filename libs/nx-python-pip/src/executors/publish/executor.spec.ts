import type { ExecutorContext } from '@nx/devkit'
import { spawnSync } from 'node:child_process'
import publishExecutor from './executor'

jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }))

const mockSpawnSync = jest.mocked(spawnSync)

function context (): ExecutorContext {
  return {
    root:                   '/workspace',
    projectName:            'shared',
    cwd:                    '/workspace',
    isVerbose:              false,
    projectsConfigurations: {
      version:  2,
      projects: { shared: { root: 'python-packages/shared' } },
    },
  } as unknown as ExecutorContext
}

describe('publishExecutor', () => {
  afterEach(() => jest.resetAllMocks())

  it('runs twine upload --skip-existing dist/*', async () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    const result = await publishExecutor({}, context())

    expect(result).toEqual({ success: true })
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'python3', ['-m', 'twine', 'upload', '--skip-existing', 'dist/*'],
      { cwd: '/workspace/python-packages/shared', stdio: 'inherit' },
    )
  })

  it('previews instead of uploading when dryRun is set, without shelling out', async () => {
    const result = await publishExecutor({ dryRun: true }, context())

    expect(result).toEqual({ success: true })
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })

  it('reports failure when twine exits non-zero', async () => {
    mockSpawnSync.mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>)

    expect(await publishExecutor({}, context())).toEqual({ success: false })
  })
})
