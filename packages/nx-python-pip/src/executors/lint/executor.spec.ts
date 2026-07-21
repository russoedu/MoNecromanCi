import type { ExecutorContext } from '@nx/devkit'
import { spawnSync } from 'node:child_process'
import lintExecutor from './executor'

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

describe('lintExecutor', () => {
  afterEach(() => jest.resetAllMocks())

  it('runs ruff check . in the project directory', async () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    const result = await lintExecutor({}, context())

    expect(result).toEqual({ success: true })
    expect(mockSpawnSync).toHaveBeenCalledWith('python3', ['-m', 'ruff', 'check', '.'], { cwd: '/workspace/apps/svc', stdio: 'inherit' })
  })

  it('reports failure when ruff exits non-zero', async () => {
    mockSpawnSync.mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>)

    expect(await lintExecutor({}, context())).toEqual({ success: false })
  })
})
