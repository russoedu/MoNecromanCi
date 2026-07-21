import { execFileSync } from 'node:child_process'

// `nx/release` transitively pulls in Nx's daemon-client/analytics modules,
// which probe for a real workspace root at import time — fine at runtime
// (this package is always installed inside a real Nx workspace) but fatal
// under Jest's synthetic module environment. Mocked with a bare-bones base
// class exposing just what PythonVersionActions extends/uses.
jest.mock('nx/release', () => ({
  VersionActions: class {
    releaseGroup:          unknown
    projectGraphNode:      unknown
    finalConfigForProject: unknown
    constructor (releaseGroup: unknown, projectGraphNode: unknown, finalConfigForProject: unknown) {
      this.releaseGroup = releaseGroup
      this.projectGraphNode = projectGraphNode
      this.finalConfigForProject = finalConfigForProject
    }
  },
}))
jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }))

import PythonVersionActions from './versionActions'

const mockExecFileSync = jest.mocked(execFileSync)

/** A minimal in-memory stand-in for Nx's Tree, just what these tests touch. */
function fakeTree (files: Record<string, string>) {
  return {
    read:  (path: string) => (Object.hasOwn(files, path) ? files[path] : null),
    write: (path: string, content: string) => { files[path] = content },
  } as unknown as import('@nx/devkit').Tree
}

function instance (): PythonVersionActions {
  const releaseGroup = {} as never
  const projectGraphNode = { name: 'pyshared', data: { root: 'python-packages/pyshared' } } as never
  const finalConfigForProject = {} as never

  return new PythonVersionActions(releaseGroup, projectGraphNode, finalConfigForProject)
}

describe('PythonVersionActions', () => {
  afterEach(() => jest.resetAllMocks())

  describe('readCurrentVersionFromSourceManifest', () => {
    it('reads the version from pyproject.toml', async () => {
      const files = { 'python-packages/pyshared/pyproject.toml': '[project]\nname = "pyshared"\nversion = "1.2.3"\n' }
      const result = await instance().readCurrentVersionFromSourceManifest(fakeTree(files))
      expect(result).toEqual({ currentVersion: '1.2.3', manifestPath: 'python-packages/pyshared/pyproject.toml' })
    })

    it('returns null when the manifest does not exist', async () => {
      expect(await instance().readCurrentVersionFromSourceManifest(fakeTree({}))).toBeNull()
    })

    it('throws when the manifest has no version line', async () => {
      const files = { 'python-packages/pyshared/pyproject.toml': '[project]\nname = "pyshared"\n' }
      await expect(instance().readCurrentVersionFromSourceManifest(fakeTree(files))).rejects.toThrow('Could not find a "version = ..." line')
    })
  })

  describe('updateProjectVersion', () => {
    it('writes the new version into pyproject.toml, preserving the rest', async () => {
      const files = { 'python-packages/pyshared/pyproject.toml': '[project]\nname = "pyshared"\nversion = "1.0.0"\ndescription = ""\n' }
      const tree = fakeTree(files)
      const messages = await instance().updateProjectVersion(tree, '1.1.0')
      expect(files['python-packages/pyshared/pyproject.toml']).toContain('version = "1.1.0"')
      expect(files['python-packages/pyshared/pyproject.toml']).toContain('description = ""')
      expect(messages).toEqual(['Updated python-packages/pyshared/pyproject.toml to version 1.1.0'])
    })

    it('does not misinterpret a "$" in the new version as a replacement pattern', async () => {
      const files = { 'python-packages/pyshared/pyproject.toml': 'version = "1.0.0"\n' }
      const tree = fakeTree(files)
      await instance().updateProjectVersion(tree, '1.0.0-$1')
      expect(files['python-packages/pyshared/pyproject.toml']).toContain('version = "1.0.0-$1"')
    })
  })

  describe('readCurrentVersionFromRegistry', () => {
    it('parses the latest version from pip index versions', async () => {
      mockExecFileSync.mockReturnValue('pyshared (1.2.3)\nAvailable versions: 1.2.3, 1.2.2\n')
      const result = await instance().readCurrentVersionFromRegistry(fakeTree({}), undefined)
      expect(result).toEqual({ currentVersion: '1.2.3', logText: 'from pip index versions' })
    })

    it('returns a null current version when the package is not found', async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not found')
      })
      const result = await instance().readCurrentVersionFromRegistry(fakeTree({}), undefined)
      expect(result).toEqual({ currentVersion: null, logText: 'package not found on registry' })
    })
  })

  describe('readCurrentVersionOfDependency + updateProjectDependencies', () => {
    it('are no-ops — internal-lib dependencies are vendored, not registry references', async () => {
      const dependency = await instance().readCurrentVersionOfDependency(fakeTree({}), {} as never, 'pycore')
      expect(dependency).toEqual({ currentVersion: null, dependencyCollection: null })

      const updates = await instance().updateProjectDependencies(fakeTree({}), {} as never, { pycore: '1.0.0' })
      expect(updates).toEqual([])
    })
  })
})
