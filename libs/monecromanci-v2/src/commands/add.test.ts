jest.mock('../nx', () => ({
  runNx:    jest.fn(),
  runShell: jest.fn(() => 0),
  quote:    jest.fn((value: string) => `"${value}"`),
}))
jest.mock('../prompts', () => ({ promptText: jest.fn() }))
jest.mock('@inquirer/prompts', () => ({ select: jest.fn(), input: jest.fn() }))

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { select } from '@inquirer/prompts'
import { runNx, runShell } from '../nx'
import { promptText } from '../prompts'
import { runAdd } from './add'

const mockRunNx = jest.mocked(runNx)
const mockRunShell = jest.mocked(runShell)
const mockSelect = jest.mocked(select)
const mockPromptText = jest.mocked(promptText)

let workspaceRoot: string

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci2-add-'))
  jest.spyOn(process, 'cwd').mockReturnValue(workspaceRoot)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  writeFileSync(join(workspaceRoot, 'nx.json'), '{}')
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@demo/source', devDependencies: {} }))
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

describe('runAdd', () => {
  it('refuses to run outside a workspace root', async () => {
    rmSync(join(workspaceRoot, 'nx.json'))
    await expect(runAdd('react-app', 'web', {})).rejects.toThrow('No nx.json found here')
    expect(mockRunNx).not.toHaveBeenCalled()
  })

  it('installs @nx/react on first use, then delegates to the app generator', async () => {
    await runAdd('react-app', 'web', {})

    expect(mockRunNx).toHaveBeenNthCalledWith(1, ['add', '@nx/react'], workspaceRoot)
    expect(mockRunNx).toHaveBeenNthCalledWith(2, [
      'g', '@nx/react:app', 'apps/web',
      '--bundler=vite',
      '--unitTestRunner=jest',
      '--linter=eslint',
      '--style=css',
      '--e2eTestRunner=none',
      '--no-interactive',
    ], workspaceRoot)
  })

  it('skips the plugin install when it is already a devDependency', async () => {
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'demo', devDependencies: { '@nx/react': '^23.0.0' } }))

    await runAdd('react-app', 'web', {})

    expect(mockRunNx).toHaveBeenCalledTimes(1)
    expect(mockRunNx.mock.calls[0][0][0]).toBe('g')
  })

  it('generates a function app: core-tools preflight, plain install, init with --directory, then new', async () => {
    await runAdd('function-app', 'api', {})

    // Preflight: the generators shell out to the func CLI even at generation time.
    expect(mockRunShell).toHaveBeenNthCalledWith(1, 'func', ['--version'], workspaceRoot)
    // Plain npm install — `nx add` would run the plugin's bare init generator, which requires args and always fails.
    expect(mockRunShell).toHaveBeenNthCalledWith(2, 'npm', ['install', '--save-dev', '@nxazure/func'], workspaceRoot)
    expect(mockRunNx).toHaveBeenNthCalledWith(1, ['g', '@nxazure/func:init', 'api', '--directory=apps/api', '--no-interactive'], workspaceRoot)
    expect(mockRunNx).toHaveBeenNthCalledWith(2, ['g', '@nxazure/func:new', 'hello', '--project=api', '--template="HTTP trigger"'], workspaceRoot)
  })

  it('fails fast with install instructions when Azure Functions Core Tools is missing', async () => {
    mockRunShell.mockReturnValueOnce(1)

    await expect(runAdd('function-app', 'api', {})).rejects.toThrow('Azure Functions Core Tools not found')
    expect(mockRunNx).not.toHaveBeenCalled()
  })

  it('fails loudly when the @nxazure/func install exits non-zero', async () => {
    mockRunShell.mockReturnValueOnce(0).mockReturnValueOnce(1)

    await expect(runAdd('function-app', 'api', {})).rejects.toThrow('npm install of @nxazure/func failed with exit code 1')
  })

  it('generates a publishable lib under packages/ with the scope from the root manifest', async () => {
    await runAdd('npm-lib', 'sdk', {})

    expect(mockRunNx).toHaveBeenCalledWith([
      'g', '@nx/js:lib', 'packages/sdk',
      '--publishable',
      '--importPath=@demo/sdk',
      '--bundler=tsc',
      '--unitTestRunner=jest',
      '--linter=eslint',
      '--no-interactive',
    ], workspaceRoot)
  })

  it('prefers an explicit --scope for a publishable lib', async () => {
    await runAdd('npm-lib', 'sdk', { scope: '@acme' })

    expect(mockRunNx.mock.calls[0][0]).toContain('--importPath=@acme/sdk')
  })

  it('generates an internal lib under libs/ and marks it private', async () => {
    // The generator is mocked, so pre-create the manifest it would have written.
    mkdirSync(join(workspaceRoot, 'libs/utils'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'libs/utils/package.json'), JSON.stringify({ name: '@demo/utils' }))

    await runAdd('internal-lib', 'utils', {})

    expect(mockRunNx).toHaveBeenCalledWith([
      'g', '@nx/js:lib', 'libs/utils',
      '--bundler=none',
      '--unitTestRunner=jest',
      '--linter=eslint',
      '--no-interactive',
    ], workspaceRoot)
    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'libs/utils/package.json'), 'utf8')) as { private: boolean }
    expect(manifest.private).toBe(true)
  })

  it('prompts for the kind and name when omitted', async () => {
    mockSelect.mockResolvedValue('react-app')
    mockPromptText.mockResolvedValue('shop')

    await runAdd(undefined, undefined, {})

    expect(mockSelect).toHaveBeenCalled()
    expect(mockPromptText).toHaveBeenCalledWith('Project name')
    expect(mockRunNx.mock.calls.at(-1)?.[0]).toContain('apps/shop')
  })
})
