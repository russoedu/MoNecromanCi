import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing'
import type { Tree } from '@nx/devkit'
import DartVersionActions from './versionActions'

const PUBSPEC = `name: shared
version: 1.2.3

environment:
  sdk: ^3.6.0

resolution: workspace
`

let tree: Tree
let actions: DartVersionActions

/**
 * Builds a `DartVersionActions` bound to a project at `packages/shared`.
 *
 * @remarks
 * `VersionActions`' constructor signature is Nx-internal, so the instance is
 * created without invoking it and only `projectGraphNode` — the one thing
 * these methods read — is supplied.
 */
function actionsFor(root: string): DartVersionActions {
  const instance = Object.create(DartVersionActions.prototype) as DartVersionActions
  Object.assign(instance, { projectGraphNode: { name: 'shared', data: { root } } })
  return instance
}

beforeEach(() => {
  tree = createTreeWithEmptyWorkspace()
  actions = actionsFor('packages/shared')
})

describe('readCurrentVersionFromSourceManifest', () => {
  it('reads the version from the project pubspec', async () => {
    tree.write('packages/shared/pubspec.yaml', PUBSPEC)

    await expect(actions.readCurrentVersionFromSourceManifest(tree)).resolves.toEqual({
      currentVersion: '1.2.3',
      manifestPath: 'packages/shared/pubspec.yaml'
    })
  })

  it('returns null when the project has no pubspec at all', async () => {
    await expect(actions.readCurrentVersionFromSourceManifest(tree)).resolves.toBeNull()
  })

  it('throws a diagnosable error when the pubspec declares no version', async () => {
    tree.write('packages/shared/pubspec.yaml', 'name: shared\nenvironment:\n  sdk: ^3.6.0\n')

    await expect(actions.readCurrentVersionFromSourceManifest(tree)).rejects.toThrow(
      /Could not find a top-level "version:" key in packages\/shared\/pubspec\.yaml/
    )
  })
})

describe('updateProjectVersion', () => {
  it('writes the new version back into the pubspec', async () => {
    tree.write('packages/shared/pubspec.yaml', PUBSPEC)

    const log = await actions.updateProjectVersion(tree, '2.0.0')

    expect(tree.read('packages/shared/pubspec.yaml', 'utf8')).toContain('version: 2.0.0')
    expect(log.join(' ')).toContain('packages/shared/pubspec.yaml')
  })

  it('leaves the rest of the pubspec untouched, including resolution: workspace', async () => {
    tree.write('packages/shared/pubspec.yaml', PUBSPEC)

    await actions.updateProjectVersion(tree, '9.9.9')

    const updated = tree.read('packages/shared/pubspec.yaml', 'utf8') ?? ''
    expect(updated).toContain('resolution: workspace')
    expect(updated).toContain('sdk: ^3.6.0')
  })
})

describe('registry and dependency behaviour', () => {
  it('reports no registry version — Dart packages here are released by git tag only', async () => {
    await expect(actions.readCurrentVersionFromRegistry(tree, undefined)).resolves.toEqual({
      currentVersion: null,
      logText: expect.stringContaining('git tag')
    })
  })

  it('reports nothing for a dependency — workspace members resolve locally', async () => {
    await expect(
      actions.readCurrentVersionOfDependency(tree, {} as never, 'core')
    ).resolves.toEqual({ currentVersion: null, dependencyCollection: null })
  })

  it('rewrites no dependency versions', async () => {
    await expect(actions.updateProjectDependencies(tree, {} as never, {})).resolves.toEqual([])
  })
})

describe('the versionActions path generators stamp onto a project', () => {
  it("is resolvable through this package's own exports map", () => {
    // The generator writes this path as a *string* into project.json, so a typo
    // or a moved file would not fail any build — it would surface only as a
    // broken `nx release`, and (because resolution happens while building the
    // release graph) it would break the release of every project in the
    // workspace. Assert the string and the exports map agree.
    const stamped = '@mnci/nx-flutter/release/version-actions'
    const subpath = stamped.replace('@mnci/nx-flutter', '.')

    // Read as data, not imported: a static import would need
    // `resolveJsonModule` and would drag package.json into the emitted output.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const manifest = require('../../package.json') as {
      name: string
      exports: Record<string, { default: string }>
    }
    expect(stamped.startsWith(manifest.name)).toBe(true)
    expect(manifest.exports[subpath]?.default).toBe('./dist/release/versionActions.js')
  })
})
