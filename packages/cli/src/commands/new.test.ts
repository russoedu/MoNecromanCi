jest.mock('../nx', () => ({ runNpx: jest.fn(), runShell: jest.fn() }))
jest.mock('../overlay', () => ({ applyOverlay: jest.fn(), DEFAULT_STACK: { linter: 'eslint', testRunner: 'jest' } }))
jest.mock('../prompts', () => ({ promptCi: jest.fn(), promptRegistry: jest.fn(), promptStack: jest.fn(), promptText: jest.fn() }))

import { join } from 'node:path'
import { runNpx, runShell } from '../nx'
import { applyOverlay } from '../overlay'
import { promptCi, promptRegistry, promptStack, promptText } from '../prompts'
import { runNew } from './new'

const mockRunNpx = jest.mocked(runNpx)
const mockRunShell = jest.mocked(runShell)
const mockApplyOverlay = jest.mocked(applyOverlay)
const mockPromptCi = jest.mocked(promptCi)
const mockPromptRegistry = jest.mocked(promptRegistry)
const mockPromptStack = jest.mocked(promptStack)
const mockPromptText = jest.mocked(promptText)

/** The `--yes` / flagless stack the overlay mock exposes as DEFAULT_STACK. */
const DEFAULT_STACK = { linter: 'eslint', testRunner: 'jest' } as const

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
      scope:         '@demo',
      registry:      { kind: 'npm' },
      agent:         'ubuntu-latest',
      variableGroup: 'Build',
      ci:            'azure',
      stack:         DEFAULT_STACK,
    })
  })

  it('passes an explicit agent and variable group through to the overlay', async () => {
    await runNew('demo', { yes: true, agent: 'MyPool', variableGroup: 'CiSecrets' })

    expect(mockApplyOverlay).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      agent:         'MyPool',
      variableGroup: 'CiSecrets',
    }))
  })

  it('passes an explicit --ci flag through to the overlay without prompting', async () => {
    await runNew('demo', { yes: true, ci: 'github' })

    expect(mockApplyOverlay).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ ci: 'github' }))
    expect(mockPromptCi).not.toHaveBeenCalled()
  })

  it('accepts --ci both', async () => {
    await runNew('demo', { yes: true, ci: 'both' })

    expect(mockApplyOverlay).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ ci: 'both' }))
  })

  it('skips the Azure-only variable-group prompt when --ci github is chosen (falls back to the Build default unasked)', async () => {
    mockPromptText
      .mockResolvedValueOnce('shop') // workspace name
      .mockResolvedValueOnce('@shop') // scope
      .mockResolvedValueOnce('ubuntu-latest') // agent
    mockPromptRegistry.mockResolvedValue({ kind: 'npm' })
    mockPromptStack.mockResolvedValue(DEFAULT_STACK)

    await runNew(undefined, { ci: 'github' })

    expect(mockPromptCi).not.toHaveBeenCalled()
    expect(mockPromptText).not.toHaveBeenCalledWith('Azure DevOps variable group holding the npm PAT', 'Build')
    expect(mockApplyOverlay).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ ci: 'github', variableGroup: 'Build' }))
  })

  it('installs the commit toolchain for real (default stack adds nothing extra)', async () => {
    await runNew('demo', { yes: true })

    const workspaceRoot = join('/somewhere', 'demo')
    // Default stack: eslint (no oxlint), jest — TS stays the preset's TS 6.
    expect(mockRunShell).toHaveBeenCalledWith('npm', ['install', '--save-dev', 'husky', '@commitlint/cli', '@commitlint/config-conventional'], workspaceRoot)
    // No `npm pkg set` — the overlay stamps `prepare: husky` into the scripts.
    expect(mockRunShell).not.toHaveBeenCalledWith('npm', expect.arrayContaining(['pkg']), workspaceRoot)
    expect(mockRunShell).toHaveBeenCalledWith('npx', ['husky'], workspaceRoot)
  })

  it('installs oxc-standard (oxlint + oxfmt preset) alongside the commit toolchain when oxlint is chosen', async () => {
    await runNew('demo', { yes: true, linter: 'oxlint', testRunner: 'vitest' })

    const workspaceRoot = join('/somewhere', 'demo')
    expect(mockRunShell).toHaveBeenCalledWith('npm', ['install', '--save-dev', 'oxc-standard', 'husky', '@commitlint/cli', '@commitlint/config-conventional'], workspaceRoot)
    expect(mockApplyOverlay).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ stack: { linter: 'oxlint', testRunner: 'vitest' } }))
  })

  it('resolves Azure Artifacts coordinates from flags without prompting', async () => {
    await runNew('demo', { yes: true, scope: '@acme', organization: 'org', project: 'proj', artifactsFeed: 'feed' })

    expect(mockApplyOverlay).toHaveBeenCalledWith(expect.any(String), {
      scope:         '@acme',
      registry:      { kind: 'azure-artifacts', organization: 'org', project: 'proj', artifactsFeed: 'feed' },
      agent:         'ubuntu-latest',
      variableGroup: 'Build',
      ci:            'azure',
      stack:         DEFAULT_STACK,
    })
    expect(mockPromptCi).not.toHaveBeenCalled()
    expect(mockPromptRegistry).not.toHaveBeenCalled()
    expect(mockPromptStack).not.toHaveBeenCalled()
    expect(mockPromptText).not.toHaveBeenCalled()
  })

  it('prompts for name, scope, registry, agent and variable group when nothing is provided', async () => {
    mockPromptText
      .mockResolvedValueOnce('shop') // workspace name
      .mockResolvedValueOnce('@shop') // scope
      .mockResolvedValueOnce('ubuntu-latest') // agent
      .mockResolvedValueOnce('Build') // variable group
    mockPromptRegistry.mockResolvedValue({ kind: 'npm' })
    mockPromptCi.mockResolvedValue('azure')
    mockPromptStack.mockResolvedValue({ linter: 'oxlint', testRunner: 'vitest' })

    await runNew(undefined, {})

    expect(mockPromptText).toHaveBeenCalledWith('Workspace name')
    expect(mockPromptText).toHaveBeenCalledWith('CI build agent/runner (vmImage, GitHub Actions runner label, or self-hosted pool name)', 'ubuntu-latest')
    expect(mockPromptText).toHaveBeenCalledWith('Azure DevOps variable group holding the npm PAT', 'Build')
    expect(mockPromptRegistry).toHaveBeenCalled()
    expect(mockPromptCi).toHaveBeenCalled()
    expect(mockPromptStack).toHaveBeenCalled()
    expect(mockApplyOverlay).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ stack: { linter: 'oxlint', testRunner: 'vitest' } }))
    expect(mockRunNpx.mock.calls[0][0]).toContain('shop')
  })

  it('fails loudly when the commit-toolchain install exits non-zero', async () => {
    mockRunShell.mockReturnValueOnce(1)

    await expect(runNew('demo', { yes: true })).rejects.toThrow('toolchain failed with exit code 1')
  })

  it('rejects an invalid workspace name before creating anything (no create-nx-workspace, no install)', async () => {
    await expect(runNew('Not Valid!', { yes: true })).rejects.toThrow('Workspace name \'Not Valid!\' is invalid')

    expect(mockRunNpx).not.toHaveBeenCalled()
    expect(mockApplyOverlay).not.toHaveBeenCalled()
    expect(mockRunShell).not.toHaveBeenCalled()
  })

  it('rejects an explicitly empty workspace name (bypasses promptText, since `??` only substitutes on undefined)', async () => {
    await expect(runNew('', { yes: true })).rejects.toThrow('Workspace name \'\' is invalid')

    expect(mockRunNpx).not.toHaveBeenCalled()
  })
})
