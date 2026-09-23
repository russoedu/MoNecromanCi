import { execFileSync } from 'node:child_process'
import type { Tree } from '@nx/devkit'

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

import PythonVersionActions from './python-version.repository'

const mockExecFileSync = jest.mocked(execFileSync)

/** A minimal in-memory stand-in for Nx's Tree, just what these tests touch. */
function fakeTree (files: Record<string, string>) {
  return {
    read:  (path: string) => (Object.hasOwn(files, path) ? files[path] : null),
    write: (path: string, content: string) => {
      files[path] = content
    },
  } as unknown as Tree
}

function instance (): PythonVersionActions {
  const releaseGroup = {} as never
  const projectGraphNode = { name: 'pyshared', data: { root: 'python-packages/pyshared' } } as never
  const finalConfigForProject = {} as never

  return new PythonVersionActions(releaseGroup, projectGraphNode, finalConfigForProject)
}

/**
 * The two manifests these tests need: this project's, and the dependency's.
 *
 * @param dependencies - Entries for this project's `dependencies` array.
 * @param extra - Extra tables appended to this project's manifest.
 * @returns A Tree file map.
 */
function manifests (
  dependencies: string,
  extra = '',
  distribution = 'pycore',
): Record<string, string> {
  return {
    'python-packages/pyshared/pyproject.toml': `[project]
name = "pyshared"
version = "1.2.3"
dependencies = [${dependencies}]
${extra}`,
    'python-packages/pycore/pyproject.toml': `[project]\nname = "${distribution}"\nversion = "0.24.0"\n`,
  }
}

/**
 * A project graph naming the dependency's root, which is how the distribution
 * name is looked up - Nx names a dependency by PROJECT while a manifest names
 * it by DISTRIBUTION.
 *
 * @returns The minimal graph these tests read.
 */
function graph () {
  return {
    nodes: {
      pyshared: { data: { root: 'python-packages/pyshared' } },
      pycore:   { data: { root: 'python-packages/pycore' } },
    },
  } as never
}

describe('PythonVersionActions', () => {
  afterEach(() => jest.resetAllMocks())

  describe('readCurrentVersionFromSourceManifest', () => {
    it('reads the version from pyproject.toml', async () => {
      const files = {
        'python-packages/pyshared/pyproject.toml':
          '[project]\nname = "pyshared"\nversion = "1.2.3"\n',
      }
      const result = await instance().readCurrentVersionFromSourceManifest(fakeTree(files))
      expect(result).toEqual({
        currentVersion: '1.2.3',
        manifestPath:   'python-packages/pyshared/pyproject.toml',
      })
    })

    it('returns null when the manifest does not exist', async () => {
      expect(await instance().readCurrentVersionFromSourceManifest(fakeTree({}))).toBeNull()
    })

    it('throws when the manifest has no version line', async () => {
      const files = { 'python-packages/pyshared/pyproject.toml': '[project]\nname = "pyshared"\n' }
      await expect(
        instance().readCurrentVersionFromSourceManifest(fakeTree(files)),
      ).rejects.toThrow('Could not find a "version = ..." line')
    })
  })

  describe('updateProjectVersion', () => {
    it('writes the new version into pyproject.toml, preserving the rest', async () => {
      const files = {
        'python-packages/pyshared/pyproject.toml':
          '[project]\nname = "pyshared"\nversion = "1.0.0"\ndescription = ""\n',
      }
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

  describe('readCurrentVersionOfDependency', () => {
    it('reads the version this project requires of a dependency', async () => {
      const files = manifests('"pycore>=0.23.0"')

      expect(
        await instance().readCurrentVersionOfDependency(fakeTree(files), graph(), 'pycore'),
      ).toEqual({ currentVersion: '0.23.0', dependencyCollection: 'dependencies' })
    })

    it('strips the operator, which is not part of the version', async () => {
      /*
       * Nx matches this value against /^[~^=]/ to detect an npm prefix and may
       * hand it straight back as the new version. A PEP 508 operator round
       * tripping through that logic produces nonsense, so the operator is kept
       * in the manifest and out of this value.
       */
      const files = manifests('"pycore ~= 0.23.0"')

      const read = await instance().readCurrentVersionOfDependency(
        fakeTree(files),
        graph(),
        'pycore',
      )

      expect(read.currentVersion).toBe('0.23.0')
    })

    it.each([
      ['case', '"PyCore>=0.23.0"', 'pycore'],
      ['a separator', '"py_core>=0.23.0"', 'py-core'],
      ['a dot separator', '"py.core>=0.23.0"', 'py-core'],
    ])('matches a requirement differing only by %s', async (_label, requirement, distribution) => {
      /*
       * PEP 503 lower-cases and collapses RUNS of `-`, `_` and `.` into a
       * single `-`. It does not REMOVE separators, so `py_core` and `pycore`
       * are genuinely different distributions - the fixture names the
       * dependency accordingly rather than pretending otherwise.
       */
      const files = manifests(requirement, '', distribution)

      const read = await instance().readCurrentVersionOfDependency(
        fakeTree(files),
        graph(),
        'pycore',
      )

      expect(read.currentVersion).toBe('0.23.0')
    })

    it.each([
      ['the dependency is not required at all', manifests('"numpy>=2"')],
      ['this project has no manifest', {}],
    ])('returns null when %s', async (_label, files) => {
      expect(
        await instance().readCurrentVersionOfDependency(fakeTree({ ...files }), graph(), 'pycore'),
      ).toEqual({ currentVersion: null, dependencyCollection: null })
    })

    it('returns null for a VENDORED dependency, which is correct and not unfinished', async () => {
      /*
       * The build executor copies the internal lib's module into this wheel,
       * so there is no requirement entry and no published version to track. It
       * is still a real dependency - the graph plugin reports the edge - with
       * nothing in the manifest to rewrite.
       */
      const files = manifests('', '\n[tool.mnci-python-pip]\nvendor = ["pycore"]\n')

      expect(
        await instance().readCurrentVersionOfDependency(fakeTree(files), graph(), 'pycore'),
      ).toEqual({ currentVersion: null, dependencyCollection: null })
    })
  })

  describe('updateProjectDependencies', () => {
    it('rewrites the requirement and KEEPS the operator', async () => {
      /*
       * The operator is the meaning. `>=0.23.0` states a floor; rewriting it
       * to `==0.24.0` would change what the dependency means while looking
       * like a version bump.
       */
      const files = manifests('"pycore>=0.23.0"')
      const messages = await instance().updateProjectDependencies(fakeTree(files), graph(), {
        pycore: '0.24.0',
      })

      expect(files['python-packages/pyshared/pyproject.toml']).toContain('"pycore>=0.24.0"')
      expect(messages).toEqual([
        'Updated python-packages/pyshared/pyproject.toml: "pycore>=0.23.0" -> "pycore>=0.24.0"',
      ])
    })

    it('strips an npm version prefix, which means nothing in PEP 508', async () => {
      const files = manifests('"pycore>=0.23.0"')
      await instance().updateProjectDependencies(fakeTree(files), graph(), { pycore: '^0.24.0' })

      expect(files['python-packages/pyshared/pyproject.toml']).toContain('"pycore>=0.24.0"')
    })

    it('leaves every other line of the manifest untouched', async () => {
      const files = manifests('\n  "numpy>=2",  # pinned by hand\n  "pycore>=0.23.0",\n')
      const before = files['python-packages/pyshared/pyproject.toml']
      await instance().updateProjectDependencies(fakeTree(files), graph(), { pycore: '0.24.0' })
      const after = files['python-packages/pyshared/pyproject.toml']

      // Comments, ordering and spacing survive: the text is edited, not parsed
      // and re-emitted as TOML.
      expect(after).toContain('# pinned by hand')
      expect(after.replace('0.24.0', '0.23.0')).toBe(before)
    })

    it('REPORTS a requirement it cannot rewrite rather than skipping it', async () => {
      /*
       * A dependant whose specifier did not move is exactly the stale
       * reference this method exists to prevent, and a silent skip would look
       * identical to having nothing to do.
       */
      const files = manifests('"pycore"')
      const messages = await instance().updateProjectDependencies(fakeTree(files), graph(), {
        pycore: '0.24.0',
      })

      expect(messages).toEqual([
        expect.stringContaining('Could not update pycore to 0.24.0'),
      ])
      expect(files['python-packages/pyshared/pyproject.toml']).toContain('"pycore"')
    })

    it('reports a vendored dependency as having nothing to update', async () => {
      const files = manifests('', '\n[tool.mnci-python-pip]\nvendor = ["pycore"]\n')
      const messages = await instance().updateProjectDependencies(fakeTree(files), graph(), {
        pycore: '0.24.0',
      })

      expect(messages).toEqual([expect.stringContaining('vendored into the wheel')])
    })

    it('does not write when nothing changed', async () => {
      const files = manifests('"numpy>=2"')
      const tree = fakeTree(files)
      const write = jest.spyOn(tree, 'write')
      await instance().updateProjectDependencies(tree, graph(), { pycore: '0.24.0' })

      expect(write).not.toHaveBeenCalled()
    })
  })
})
