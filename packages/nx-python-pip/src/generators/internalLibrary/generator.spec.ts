import { readProjectConfiguration, type Tree } from '@nx/devkit'
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing'
import internalLibraryGenerator from './generator'

describe('internalLibraryGenerator', () => {
  let tree: Tree

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace()
  })

  it('writes lint + test targets only — no build, no publish, no release override', async () => {
    await internalLibraryGenerator(tree, { name: 'core' })

    const project = readProjectConfiguration(tree, 'core')
    expect(project.root).toBe('libs/core')
    expect(Object.keys(project.targets ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual(['lint', 'test'])
    expect(project.release).toBeUndefined()

    expect(tree.read('libs/core/pyproject.toml', 'utf8')).toContain('name = "core"')
    expect(tree.exists('libs/core/core/__init__.py')).toBe(true)
  })
})
