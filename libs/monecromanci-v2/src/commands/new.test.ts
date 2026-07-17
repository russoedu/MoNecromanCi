jest.mock('../nx', () => ({ runNpx: jest.fn(), runShell: jest.fn() }))
jest.mock('../overlay', () => ({ applyOverlay: jest.fn() }))
jest.mock('../prompts', () => ({ promptRegistry: jest.fn(), promptText: jest.fn() }))

import { join } from 'node:path'
import { runNpx, runShell } from '../nx'
import { applyOverlay } from '../overlay'
import { promptRegistry, promptText } from '../prompts'
import { runNew } from './new'

const mockRunNpx = jest.mocked(runNpx)
const mockRunShell = jest.mocked(runShell)
const mockApplyOverlay = jest.mocked(applyOverlay)
const mockPromptRegistry = jest.mocked(promptRegistry)
const mockPromptText = jest.mocked(promptText)

beforeEach(() => {
  jest.spyOn(process, 'cwd').mockReturnValue('/somewhere')
  jest.spyOn(console, 'log').mockImplementation(() => {})
  mockRunShell.mockReturnValue(0)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('runNew', () => {
  it('creates the workspace with the Nx TS preset and applies the overlay (--yes defaults)', async () => {
    await runNew('demo', { yes: true })

    expect(mockRunNpx).toHaveBeenCalledWith([
      '--yes',
      'create-nx-workspace@latest',
      'demo',
      '--preset=ts',
      '--pm=npm',
      '--nxCloud=skip',
      '--no-interactive',
    ], '/somewhere')
    expect(mockApplyOverlay).toHaveBeenCalledWith(join('/somewhere', 'demo'), {
      scope:    '@demo',
      registry: { kind: 'npm' },
    })
  })

  it('installs husky and commitlint for real inside the new workspace', async () => {
    await runNew('demo', { yes: true })

    const workspaceRoot = join('/somewhere', 'demo')
    expect(mockRunShell).toHaveBeenCalledWith('npm', ['install', '--save-dev', 'husky', '@commitlint/cli', '@commitlint/config-conventional'], workspaceRoot)
    // No `npm pkg set` — the overlay stamps `prepare: husky` into the scripts.
    expect(mockRunShell).not.toHaveBeenCalledWith('npm', expect.arrayContaining(['pkg']), workspaceRoot)
    expect(mockRunShell).toHaveBeenCalledWith('npx', ['husky'], workspaceRoot)
  })

  it('resolves Azure Artifacts coordinates from flags without prompting', async () => {
    await runNew('demo', { yes: true, scope: '@acme', organization: 'org', project: 'proj', artifactsFeed: 'feed' })

    expect(mockApplyOverlay).toHaveBeenCalledWith(expect.any(String), {
      scope:    '@acme',
      registry: { kind: 'azure-artifacts', organization: 'org', project: 'proj', artifactsFeed: 'feed' },
    })
    expect(mockPromptRegistry).not.toHaveBeenCalled()
    expect(mockPromptText).not.toHaveBeenCalled()
  })

  it('prompts for name, scope and registry when nothing is provided', async () => {
    mockPromptText.mockResolvedValueOnce('shop').mockResolvedValueOnce('@shop')
    mockPromptRegistry.mockResolvedValue({ kind: 'npm' })

    await runNew(undefined, {})

    expect(mockPromptText).toHaveBeenCalledWith('Workspace name')
    expect(mockPromptRegistry).toHaveBeenCalled()
    expect(mockRunNpx.mock.calls[0][0]).toContain('shop')
  })

  it('fails loudly when the commit-toolchain install exits non-zero', async () => {
    mockRunShell.mockReturnValueOnce(1)

    await expect(runNew('demo', { yes: true })).rejects.toThrow('commit toolchain failed with exit code 1')
  })
})
