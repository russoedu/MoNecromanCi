import { readProjectConfiguration, type Tree } from '@nx/devkit'
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing'
import functionAppGenerator from './generator'

describe('functionAppGenerator', () => {
  let tree: Tree

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace()
  })

  it('writes the Azure Functions v2 files, no pyproject.toml, no build target', async () => {
    await functionAppGenerator(tree, { name: 'api' })

    const project = readProjectConfiguration(tree, 'api')
    expect(project.root).toBe('apps/api')
    expect(project.targets?.build).toBeUndefined()
    expect(project.targets?.test?.options).toEqual({ installEditable: false })

    expect(tree.exists('apps/api/pyproject.toml')).toBe(false)
    const functionApp = tree.read('apps/api/function_app.py', 'utf8')
    expect(functionApp).toContain('func.FunctionApp(')
    expect(functionApp).toContain('from api.greeting import build_greeting')
    expect(tree.read('apps/api/host.json', 'utf8')).toContain('extensionBundle')
    expect(tree.read('apps/api/requirements.txt', 'utf8')).toContain('azure-functions')
    expect(tree.read('apps/api/api/greeting.py', 'utf8')).toContain('def build_greeting')
    expect(tree.read('apps/api/tests/test_greeting.py', 'utf8')).toContain('from api.greeting import build_greeting')
  })
})
