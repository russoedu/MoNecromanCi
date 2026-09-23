import { readProjectConfiguration, type Tree } from '@nx/devkit'
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing'
import libraryGenerator from './generator'

describe('libraryGenerator', () => {
  let tree: Tree

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace()
  })

  it('writes a publishable project: nx-release-publish + a project-level versionActions override', async () => {
    await libraryGenerator(tree, { name: 'shared', directory: 'python-packages/shared' })

    const project = readProjectConfiguration(tree, 'shared')
    expect(project.root).toBe('python-packages/shared')
    expect(project.projectType).toBe('library')
    expect(project.targets?.build?.executor).toBe('@mnci/nx-python-pip:build')
    /*
     * Named `typecheck` to match every other language's target, which is what
     * makes `nx run-many -t typecheck` cover Python at all. The generated CI's
     * verify list has always included `typecheck`; a project with no such
     * target is SKIPPED by Nx and the run still exits 0, so Python was being
     * type-checked by nothing while the workspace reported green.
     */
    expect(project.targets?.typecheck?.executor).toBe('@mnci/nx-python-pip:typecheck')
    expect(project.targets?.['nx-release-publish']).toEqual({
      executor:  '@mnci/nx-python-pip:publish',
      dependsOn: ['build'],
      options:   {},
    })
    expect(project.release?.version?.versionActions).toBe(
      '@mnci/nx-python-pip/release/version-actions',
    )
  })

  it('defaults to libs/<name> when no directory is given', async () => {
    await libraryGenerator(tree, { name: 'shared' })

    expect(readProjectConfiguration(tree, 'shared').root).toBe('libs/shared')
  })
})
