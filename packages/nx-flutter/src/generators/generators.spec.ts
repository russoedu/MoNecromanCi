import { readProjectConfiguration, type Tree } from '@nx/devkit'
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing'
import appGenerator from './application/generator'
import internalLibraryGenerator from './internalLibrary/generator'
import libraryGenerator from './library/generator'
import { ROOT_PUBSPEC } from '../internal/workspace'

let tree: Tree

beforeEach(() => {
  tree = createTreeWithEmptyWorkspace()
  tree.write('package.json', JSON.stringify({ name: '@demo/source' }))
})

/**
 * The `workspace:` entries in the root pubspec.
 *
 * @remarks
 * Only the Tree phase is exercised here — each generator also returns a
 * callback that shells out to the real `flutter create`, which is covered by
 * the e2e suite rather than mocked into meaninglessness.
 */
function members (): string[] {
  const contents = tree.read(ROOT_PUBSPEC, 'utf8') ?? ''
  return contents
    .split('\n')
    .filter(line => /^\s+-\s/.test(line))
    .map(line => line.replace(/^\s*-\s*/, '').trim())
}

describe('application generator', () => {
  it('registers the app under apps/ as a pub workspace member', async () => {
    await appGenerator(tree, { name: 'web' })

    expect(members()).toEqual(['apps/web'])
    const project = readProjectConfiguration(tree, 'web')
    expect(project.root).toBe('apps/web')
    expect(project.projectType).toBe('application')
    expect(project.tags).toEqual(['type:flutter-app'])
  })

  it('gets the full target set including build and package', async () => {
    await appGenerator(tree, { name: 'web' })

    const { targets } = readProjectConfiguration(tree, 'web')
    expect(Object.keys(targets ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'build',
      'lint',
      'package',
      'test'
    ])
    expect(targets?.lint.executor).toBe('@mnci/nx-flutter:lint')
    expect(targets?.build.executor).toBe('@mnci/nx-flutter:build')
  })

  it('declares a build output DIRECTORY under the workspace-root dist', async () => {
    await appGenerator(tree, { name: 'web' })

    const { targets } = readProjectConfiguration(tree, 'web')
    // A bare file here would make Nx's output caching raise ENOTDIR.
    expect(targets?.build.outputs).toEqual(['{workspaceRoot}/dist/apps/web'])
    expect(targets?.build.options).toEqual({ outputPath: 'dist/apps/web' })
  })

  it('names the drop zip exactly flutter-app-<name> (CI derives the build tag from it)', async () => {
    await appGenerator(tree, { name: 'web' })

    const { targets } = readProjectConfiguration(tree, 'web')
    expect(targets?.package.outputs).toEqual(['{workspaceRoot}/dist/drop/flutter-app-web.zip'])
    expect(JSON.stringify(targets?.package)).toContain("addLocalFolder('dist/apps/web')")
    expect(targets?.package.dependsOn).toEqual(['build'])
  })

  it('is not publishable — an app is packed into the drop, never released', async () => {
    await appGenerator(tree, { name: 'web' })

    expect(readProjectConfiguration(tree, 'web').release).toBeUndefined()
  })

  it('derives the root workspace pubspec name from the root package.json', async () => {
    await appGenerator(tree, { name: 'web' })

    // '@demo/source' -> unscoped 'source' -> Dart-safe 'source_workspace'.
    expect(tree.read(ROOT_PUBSPEC, 'utf8')).toContain('name: source_workspace')
  })
})

describe('library generator', () => {
  it('registers a publishable package under packages/ with a versionActions override', async () => {
    await libraryGenerator(tree, { name: 'shared' })

    const project = readProjectConfiguration(tree, 'shared')
    expect(project.root).toBe('packages/shared')
    expect(project.tags).toEqual(['type:flutter-lib'])
    // Without this, nx release looks for a package.json that does not exist and
    // fails the release for the WHOLE workspace.
    expect(project.release).toEqual({
      version: { versionActions: '@mnci/nx-flutter/release/version-actions' }
    })
  })

  it('has no build, package or publish target — publishing is the git tag', async () => {
    await libraryGenerator(tree, { name: 'shared' })

    const { targets } = readProjectConfiguration(tree, 'shared')
    expect(Object.keys(targets ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'lint',
      'test'
    ])
    expect(targets?.['nx-release-publish']).toBeUndefined()
  })
})

describe('internal-library generator', () => {
  it('registers a private package under libs/ with no release wiring', async () => {
    await internalLibraryGenerator(tree, { name: 'core' })

    const project = readProjectConfiguration(tree, 'core')
    expect(project.root).toBe('libs/core')
    expect(project.tags).toEqual(['type:flutter-internal-lib'])
    expect(project.release).toBeUndefined()
    expect(Object.keys(project.targets ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'lint',
      'test'
    ])
  })
})

describe('all three together', () => {
  it('accumulates every project into the one root pubspec, sorted', async () => {
    await libraryGenerator(tree, { name: 'shared' })
    await appGenerator(tree, { name: 'web' })
    await internalLibraryGenerator(tree, { name: 'core' })

    expect(members()).toEqual(['apps/web', 'libs/core', 'packages/shared'])
    // One root pubspec and one root analyser config, shared by all three.
    expect(tree.exists('apps/web/pubspec.yaml')).toBe(false)
    expect(tree.exists(ROOT_PUBSPEC)).toBe(true)
  })

  it('honours an explicit directory override', async () => {
    await libraryGenerator(tree, { name: 'shared', directory: 'custom/place' })

    expect(readProjectConfiguration(tree, 'shared').root).toBe('custom/place')
    expect(members()).toEqual(['custom/place'])
  })
})
