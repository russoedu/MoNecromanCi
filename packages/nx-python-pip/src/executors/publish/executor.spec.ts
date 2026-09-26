import type { ExecutorContext } from '@nx/devkit'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pythonCommand } from '../../internal/python-command.algorithm'
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

/** This release's version data, with `shared` bumped or not and a neighbour never bumped. */
function versionData (newVersion: string | null) {
  return {
    nxReleaseVersionData: {
      shared: { currentVersion: '1.2.3', newVersion },
      other:  { currentVersion: '4.5.6', newVersion: null },
    },
  }
}

describe('publishExecutor', () => {
  afterEach(() => jest.resetAllMocks())

  it('runs twine upload --skip-existing dist/*', async () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    const result = await publishExecutor({}, context())

    expect(result).toEqual({ success: true })
    expect(mockSpawnSync).toHaveBeenCalledWith(
      pythonCommand(),
      ['-m', 'twine', 'upload', '--skip-existing', 'dist/*'],
      { cwd: join('/workspace', 'python-packages/shared'), stdio: 'inherit' },
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

  describe('a project this release did not version', () => {
    // nx release is tag-only, so an untouched project's pyproject.toml holds its
    // scaffold version for ever. Publishing it anyway uploads 0.0.1 on every
    // release of its neighbours, and --skip-existing hides that behind a
    // warning and exit 0 - or, on a package PyPI has never seen, CREATES the
    // project at 0.0.1 and spends a slot in PyPI's new-project rate limit.
    it('is skipped rather than published', async () => {
      const result = await publishExecutor(versionData(null), context())

      expect(result).toEqual({ success: true })
      expect(mockSpawnSync).not.toHaveBeenCalled()
    })

    it('says which project was skipped, and why', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)

      await publishExecutor(versionData(null), context())

      expect(log).toHaveBeenCalledWith(
        'Skipped project "shared", because no new version was resolved for this project',
      )
      log.mockRestore()
    })

    it('is skipped on a dry run too, so the preview matches the real run', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)

      const result = await publishExecutor({ ...versionData(null), dryRun: true }, context())

      expect(result).toEqual({ success: true })
      expect(log).toHaveBeenCalledWith(
        'Skipped project "shared", because no new version was resolved for this project',
      )
      log.mockRestore()
    })

    it('does not skip a project that WAS versioned, whatever its neighbours did', async () => {
      mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

      const result = await publishExecutor(versionData('1.3.0'), context())

      expect(result).toEqual({ success: true })
      expect(mockSpawnSync).toHaveBeenCalledTimes(1)
    })

    it('publishes when nx passed no version data at all', async () => {
      // `nx release publish` run on its own, without the version step - there is
      // nothing to consult, so the only safe reading is "publish".
      mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

      expect(await publishExecutor({}, context())).toEqual({ success: true })
      expect(mockSpawnSync).toHaveBeenCalledTimes(1)
    })

    it('publishes when the data covers other projects but not this one', async () => {
      mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

      const result = await publishExecutor(
        { nxReleaseVersionData: { other: { currentVersion: '4.5.6', newVersion: null } } },
        context(),
      )

      expect(result).toEqual({ success: true })
      expect(mockSpawnSync).toHaveBeenCalledTimes(1)
    })
  })
})
