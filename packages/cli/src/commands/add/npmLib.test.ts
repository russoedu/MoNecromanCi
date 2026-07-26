jest.mock('../../nx', () => ({
  runNx: jest.fn(),
  runShell: jest.fn(() => 0),
}))
jest.mock('../../prompts', () => ({ promptText: jest.fn() }))
jest.mock('@inquirer/prompts', () => ({ select: jest.fn(), input: jest.fn() }))

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-add-npm-lib-'))
  mockRunShell.mockImplementation(() => 0)
  jest.spyOn(process, 'cwd').mockReturnValue(workspaceRoot)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  writeFileSync(join(workspaceRoot, 'nx.json'), '{}')
  writeFileSync(
    join(workspaceRoot, 'package.json'),
    JSON.stringify({ name: '@demo/source', devDependencies: {} })
  )
  // The generator is mocked, so pre-create the manifest it would have written
  // (every test here adds a lib named 'sdk') — addNpmLib patches it in place.
  mkdirSync(join(workspaceRoot, 'packages/sdk'), { recursive: true })
  writeFileSync(
    join(workspaceRoot, 'packages/sdk/package.json'),
    JSON.stringify({ name: '@demo/sdk' })
  )
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

describe('runAdd npm-lib', () => {
  it('generates a publishable lib under packages/ as a rollup bundle (inlines internal libs)', async () => {
    await runAdd('npm-lib', 'sdk', {})

    expect(mockRunNx).toHaveBeenCalledWith(
      [
        'g',
        '@nx/js:lib',
        'packages/sdk',
        '--publishable',
        '--importPath=@demo/sdk',
        '--bundler=rollup',
        '--unitTestRunner=jest',
        '--linter=eslint',
        '--no-interactive',
      ],
      workspaceRoot
    )
  })

  it('marks the manifest publicly publishable (npm treats a new scoped package as private otherwise)', async () => {
    await runAdd('npm-lib', 'sdk', {})

    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, 'packages/sdk/package.json'), 'utf8')
    ) as { publishConfig: { access: string } }
    expect(manifest.publishConfig).toEqual({ access: 'public' })
  })

  it('teaches the npm-lib dependency check to ignore private workspace packages', async () => {
    await runAdd('npm-lib', 'sdk', {})

    const eslintConfig = readFileSync(join(workspaceRoot, 'packages/sdk/eslint.config.mjs'), 'utf8')
    expect(eslintConfig).toContain('ignoredDependencies: privateWorkspacePackages')
    expect(eslintConfig).toContain('manifest.private === true')
    expect(eslintConfig).toContain('@nx/dependency-checks')
  })

  it('teaches the dependency check to ignore the test toolchain, which is never published', async () => {
    await runAdd('npm-lib', 'sdk', {})

    const eslintConfig = readFileSync(join(workspaceRoot, 'packages/sdk/eslint.config.mjs'), 'utf8')
    // Regression guard: rollup bundles from the entry point only, so neither the
    // Vitest config nor the spec files reach the published package. Without these
    // a vitest-stack workspace failed `npm run lint` on a freshly generated
    // npm-lib — Nx's own spec imports `vitest`, and @nx/dependency-checks then
    // demanded it be declared as a runtime dependency.
    expect(eslintConfig).toContain('{projectRoot}/vitest.config.{js,ts,mjs,mts,cjs,cts}')
    // `.spec` only: that is what every Nx generator emits, and covering an
    // unused `.test` glob too would drag an eslint-disable comment into the
    // generated file — which the consuming workspace could then flag as an
    // unused directive.
    expect(eslintConfig).toContain('{projectRoot}/**/*.spec.{js,ts,jsx,tsx}')
    expect(eslintConfig).not.toContain('eslint-disable')
  })

  it('emits an eslint config whose backticked prose does not break the template literal', async () => {
    await runAdd('npm-lib', 'sdk', {})

    // The config is built from a JS template literal, so an unescaped backtick in
    // an explanatory comment would silently truncate the generated file.
    const eslintConfig = readFileSync(join(workspaceRoot, 'packages/sdk/eslint.config.mjs'), 'utf8')
    expect(eslintConfig.trimEnd().endsWith('];')).toBe(true)
    expect(eslintConfig).toContain('export default [')
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
    const generatorCall = mockRunNx.mock.calls.find(call => call[0][0] === 'g')
    expect(generatorCall?.[0]).toContain('--importPath=@acme/sdk')
  })

  it('does not prompt for scope on the flag path (kind passed) — defaults it silently', async () => {
    await runAdd('npm-lib', 'sdk', {})

    expect(mockPromptText).not.toHaveBeenCalledWith(
      'npm scope for the published package',
      expect.anything()
    )
    expect(mockRunNx.mock.calls[0][0]).toContain('--importPath=@demo/sdk')
  })

  it('always writes an eslint config with dependency-check overrides for npm-lib', async () => {
    await runAdd('npm-lib', 'sdk', {})

    expect(existsSync(join(workspaceRoot, 'packages/sdk/eslint.config.mjs'))).toBe(true)
  })
})
