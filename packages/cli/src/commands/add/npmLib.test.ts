jest.mock('../../nx', () => ({
  runNx: jest.fn(),
  runFormatter: jest.fn(),
  runShell: jest.fn(() => 0)
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
        '--linter=none',
        '--no-interactive'
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

  it('leaves no per-project eslint config behind — an mnci workspace has exactly one, at the root', async () => {
    // The @nx/js:lib generator writes one; mnci used to overwrite it with its
    // own (NPM_LIB_ESLINT_CONFIG) carrying the @nx/dependency-checks
    // exclusions. Those exclusions now live in the root config
    // (@mnci/eslint-config's dependencyChecks block), so the generated file is
    // deleted instead. Verified separately that a project without its own
    // config still gets an inferred `lint` target and still reports real
    // violations — the e2e enforces that permanently.
    await runAdd('npm-lib', 'sdk', {})

    for (const extension of ['mjs', 'js', 'cjs', 'ts', 'mts', 'cts']) {
      expect(existsSync(join(workspaceRoot, `packages/sdk/eslint.config.${extension}`))).toBe(false)
    }
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

  it('removes the .vscode directory an Nx generator may have re-created', async () => {
    // @nx/node re-creates launch.json on every add, so cleaning it once at
    // `mnci new` is not enough — its content is already covered by the
    // <workspace>.code-workspace file mnci owns.
    mkdirSync(join(workspaceRoot, '.vscode'), { recursive: true })
    writeFileSync(join(workspaceRoot, '.vscode/extensions.json'), '{}')

    await runAdd('npm-lib', 'sdk', {})

    expect(existsSync(join(workspaceRoot, '.vscode'))).toBe(false)
  })
})
