jest.mock('../../nx', () => ({
  runNx:    jest.fn(),
  runShell: jest.fn(() => 0),
}))
jest.mock('../../prompts', () => ({ promptText: jest.fn() }))
jest.mock('@inquirer/prompts', () => ({ select: jest.fn(), input: jest.fn() }))

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { select } from '@inquirer/prompts'
import { runNx, runShell } from '../../nx'
import { promptText } from '../../prompts'
import { runAdd } from '../add'

const mockRunNx = jest.mocked(runNx)
const mockRunShell = jest.mocked(runShell)
const mockSelect = jest.mocked(select)
const mockPromptText = jest.mocked(promptText)

let workspaceRoot: string

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci2-add-npm-lib-'))
  mockRunShell.mockImplementation(() => 0)
  jest.spyOn(process, 'cwd').mockReturnValue(workspaceRoot)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  writeFileSync(join(workspaceRoot, 'nx.json'), '{}')
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@demo/source', devDependencies: {} }))
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

describe('runAdd npm-lib', () => {
  it('generates a publishable lib under packages/ as a rollup bundle (inlines internal libs)', async () => {
    await runAdd('npm-lib', 'sdk', {})

    expect(mockRunNx).toHaveBeenCalledWith([
      'g', '@nx/js:lib', 'packages/sdk',
      '--publishable',
      '--importPath=@demo/sdk',
      '--bundler=rollup',
      '--unitTestRunner=jest',
      '--linter=eslint',
      '--no-interactive',
    ], workspaceRoot)
  })

  it('teaches the npm-lib dependency check to ignore private workspace packages', async () => {
    await runAdd('npm-lib', 'sdk', {})

    const eslintConfig = readFileSync(join(workspaceRoot, 'packages/sdk/eslint.config.mjs'), 'utf8')
    expect(eslintConfig).toContain('ignoredDependencies: privateWorkspacePackages')
    expect(eslintConfig).toContain('manifest.private === true')
    expect(eslintConfig).toContain('@nx/dependency-checks')
  })

  it('prefers an explicit --scope for a publishable lib', async () => {
    await runAdd('npm-lib', 'sdk', { scope: '@acme' })

    expect(mockRunNx.mock.calls[0][0]).toContain('--importPath=@acme/sdk')
  })

  it('prompts for the npm-lib scope on the interactive path (kind not passed)', async () => {
    mockSelect.mockResolvedValue('npm-lib')
    mockPromptText.mockResolvedValueOnce('sdk').mockResolvedValueOnce('@acme') // name, then scope

    await runAdd(undefined, undefined, {})

    // Scope is prompted with the workspace's own scope (from @demo/source) as default.
    expect(mockPromptText).toHaveBeenCalledWith('npm scope for the published package', '@demo')
    const generatorCall = mockRunNx.mock.calls.find((call) => call[0][0] === 'g')
    expect(generatorCall?.[0]).toContain('--importPath=@acme/sdk')
  })

  it('does not prompt for scope on the flag path (kind passed) — defaults it silently', async () => {
    await runAdd('npm-lib', 'sdk', {})

    expect(mockPromptText).not.toHaveBeenCalledWith('npm scope for the published package', expect.anything())
    expect(mockRunNx.mock.calls[0][0]).toContain('--importPath=@demo/sdk')
  })

  it('honors an oxlint workspace: --linter=none and no per-lib eslint config', async () => {
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ mnci2: { stack: { linter: 'oxlint', testRunner: 'jest' } } }))

    await runAdd('npm-lib', 'sdk', {})

    const generatorCall = mockRunNx.mock.calls.find((call) => call[0][0] === 'g')
    expect(generatorCall?.[0]).toContain('--linter=none')
    // The dependency-check override is ESLint-specific, so oxlint writes none.
    expect(existsSync(join(workspaceRoot, 'packages/sdk/eslint.config.mjs'))).toBe(false)
  })
})
