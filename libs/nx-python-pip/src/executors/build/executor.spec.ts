import type { ExecutorContext } from '@nx/devkit'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import buildExecutor from './executor'

jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }))
jest.mock('node:fs', () => ({
  cpSync:        jest.fn(),
  mkdtempSync:   jest.fn(),
  readFileSync:  jest.fn(),
  rmSync:        jest.fn(),
  writeFileSync: jest.fn(),
}))

const mockSpawnSync = jest.mocked(spawnSync)
const mockReadFileSync = jest.mocked(readFileSync)
const mockMkdtempSync = jest.mocked(mkdtempSync)
const mockCpSync = jest.mocked(cpSync)
const mockWriteFileSync = jest.mocked(writeFileSync)
const mockRmSync = jest.mocked(rmSync)

function context (): ExecutorContext {
  return {
    root:                   '/workspace',
    projectName:            'pyshared',
    cwd:                    '/workspace',
    isVerbose:              false,
    projectsConfigurations: {
      version:  2,
      projects: {
        pyshared: { root: 'python-packages/pyshared' },
        pycore:   { root: 'libs/pycore' },
      },
    },
  } as unknown as ExecutorContext
}

describe('buildExecutor', () => {
  afterEach(() => jest.resetAllMocks())

  it('builds straight from the project directory when pyproject.toml has no vendor entry', async () => {
    mockReadFileSync.mockReturnValue('[project]\nname = "pyshared"\ndependencies = []\n' as unknown as Buffer)
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    const result = await buildExecutor({}, context())

    expect(result).toEqual({ success: true })
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'python3', ['-m', 'build', '--outdir', '/workspace/python-packages/pyshared/dist', '/workspace/python-packages/pyshared'],
      { stdio: 'inherit' },
    )
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })

  it('stages a copy and vendors the internal lib when pyproject.toml declares vendor = [...]', async () => {
    mockReadFileSync
      .mockReturnValueOnce('[project]\nname = "pyshared"\n\n[tool.mnci-python-pip]\nvendor = ["pycore"]\n' as unknown as Buffer)
      .mockReturnValueOnce('[tool.hatch.build.targets.wheel]\npackages = ["pyshared"]\n' as unknown as Buffer)
    mockMkdtempSync.mockReturnValue('/tmp/nx-python-pip-build-abc123')
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    const result = await buildExecutor({}, context())

    expect(result).toEqual({ success: true })
    // Stages the project itself, then vendors pycore's module directory in.
    expect(mockCpSync).toHaveBeenNthCalledWith(1, '/workspace/python-packages/pyshared', '/tmp/nx-python-pip-build-abc123', { recursive: true })
    expect(mockCpSync).toHaveBeenNthCalledWith(2, '/workspace/libs/pycore/pycore', '/tmp/nx-python-pip-build-abc123/pycore', { recursive: true })
    // Patches the staged pyproject.toml's wheel packages list.
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/nx-python-pip-build-abc123/pyproject.toml',
      expect.stringContaining('packages = ["pyshared", "pycore"]'),
    )
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'python3', ['-m', 'build', '--outdir', '/workspace/python-packages/pyshared/dist', '/tmp/nx-python-pip-build-abc123'],
      { stdio: 'inherit' },
    )
    // Always cleans up the staging directory, even on success.
    expect(mockRmSync).toHaveBeenCalledWith('/tmp/nx-python-pip-build-abc123', { recursive: true, force: true })
  })

  it('fails fast when a vendored project name is not registered in the workspace', async () => {
    mockReadFileSync.mockReturnValue('[tool.mnci-python-pip]\nvendor = ["does-not-exist"]\n' as unknown as Buffer)
    mockMkdtempSync.mockReturnValue('/tmp/nx-python-pip-build-abc123')
    jest.spyOn(console, 'error').mockImplementation(() => {})

    const result = await buildExecutor({}, context())

    expect(result).toEqual({ success: false })
    expect(mockSpawnSync).not.toHaveBeenCalled()
    // Still cleans up the staging directory on this early-exit path.
    expect(mockRmSync).toHaveBeenCalledWith('/tmp/nx-python-pip-build-abc123', { recursive: true, force: true })
  })

  it('reports failure when python -m build exits non-zero', async () => {
    mockReadFileSync.mockReturnValue('[project]\nname = "pyshared"\ndependencies = []\n' as unknown as Buffer)
    mockSpawnSync.mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>)

    expect(await buildExecutor({}, context())).toEqual({ success: false })
  })
})
