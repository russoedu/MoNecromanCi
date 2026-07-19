jest.mock('../nx', () => ({
  runNx:    jest.fn(),
  runShell: jest.fn(() => 0),
  quote:    jest.fn((value: string) => `"${value}"`),
}))
jest.mock('../prompts', () => ({ promptText: jest.fn() }))
jest.mock('@inquirer/prompts', () => ({ select: jest.fn(), input: jest.fn() }))

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('builds a react app per environment (dev/uat/prod), each into its own drop zip', async () => {
    // The generator is mocked, so pre-create the manifest it would have written.
    mkdirSync(join(workspaceRoot, 'apps/web'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/web/package.json'), JSON.stringify({ name: '@demo/web', version: '0.0.1', private: true }))

    await runAdd('react-app', 'web', {})

    // adm-zip is the packager the target runs.
    expect(mockRunShell).toHaveBeenCalledWith('npm', ['install', '--save-dev', 'adm-zip', '--no-audit', '--no-fund'], workspaceRoot)

    // A .env.<env> is scaffolded per environment (public VITE_ config).
    for (const environment of ['dev', 'uat', 'prod']) {
      expect(readFileSync(join(workspaceRoot, `apps/web/.env.${environment}`), 'utf8')).toContain(`VITE_ENVIRONMENT=${environment}`)
    }

    // React apps are inference-only (no project.json): targets are attached via
    // the manifest's `nx` field, preserving the existing manifest.
    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'apps/web/package.json'), 'utf8')) as { name: string, nx: { targets: Record<string, { executor: string, dependsOn?: string[], outputs: string[], options: { command: string, cwd?: string } }> } }
    expect(manifest.name).toBe('@demo/web')
    const targets = manifest.nx.targets

    // One build target per environment: vite build --mode <env> --outDir dist-<env>.
    for (const environment of ['dev', 'uat', 'prod']) {
      expect(targets[`build-${environment}`]).toMatchObject({ executor: 'nx:run-commands', options: { command: `vite build --mode ${environment} --outDir dist-${environment}`, cwd: 'apps/web' } })
    }

    // The package target depends on the three env builds and emits one zip per
    // environment — the exact names CI turns into per-env build tags.
    expect(targets.package.dependsOn).toEqual(['build-dev', 'build-uat', 'build-prod'])
    expect(targets.package.outputs).toEqual([
      '{workspaceRoot}/dist/drop/react-app-web-dev.zip',
      '{workspaceRoot}/dist/drop/react-app-web-uat.zip',
      '{workspaceRoot}/dist/drop/react-app-web-prod.zip',
    ])
    expect(targets.package.options.command).toContain(`writeZip('dist/drop/react-app-web-uat.zip')`)
  })

  it('generates a function app: core-tools preflight, plain install, init with --directory, then new', async () => {
    await runAdd('function-app', 'api', {})

    // Preflight: the generators shell out to the func CLI even at generation time.
    expect(mockRunShell).toHaveBeenNthCalledWith(1, 'func', ['--version'], workspaceRoot)
    // Plain npm install — `nx add` would run the plugin's bare init generator, which requires args and always fails.
    expect(mockRunShell).toHaveBeenNthCalledWith(2, 'npm', ['install', '--save-dev', '@nxazure/func'], workspaceRoot)
    expect(mockRunNx).toHaveBeenNthCalledWith(1, ['g', '@nxazure/func:init', 'api', '--directory=apps/api', '--no-interactive'], workspaceRoot)
    expect(mockRunNx).toHaveBeenNthCalledWith(2, ['g', '@nxazure/func:new', 'hello', '--project=api', '--template="HTTP trigger"'], workspaceRoot)
    // One install materialises the repaired app's @azure/functions dependency,
    // the esbuild toolchain its build target needs, the jest toolchain its test
    // target runs, AND adm-zip for its package target (a hand-rewired app
    // carries none of this from a plugin generator).
    expect(mockRunShell).toHaveBeenNthCalledWith(3, 'npm', ['install', '--save-dev', '@nx/esbuild', 'esbuild', 'jest', 'ts-jest', '@types/jest', 'adm-zip', '--no-audit', '--no-fund'], workspaceRoot)
  })

  it('repairs the function app into an esbuild single-file bundle: manifest, targets, entry, tsconfig', async () => {
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({
      name:            '@demo/source',
      devDependencies: { '@nxazure/func': '^2.1.0', '@azure/functions': '^4.0.0' },
    }))

    await runAdd('function-app', 'api', {})

    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'apps/api/package.json'), 'utf8')) as Record<string, unknown>
    // The generator leaves name empty (corrupts npm workspaces); main points at
    // the bundled file, read by the Functions host inside the output folder.
    expect(manifest.name).toBe('@demo/api')
    expect(manifest.private).toBe(true)
    expect(manifest.main).toBe('main.cjs')
    expect((manifest.dependencies as Record<string, string>)['@azure/functions']).toBe('^4.0.0')

    // The bundle entry: functions register by being imported from here.
    expect(readFileSync(join(workspaceRoot, 'apps/api/src/main.ts'), 'utf8')).toContain(`import './functions/hello.js'`)

    const project = JSON.parse(readFileSync(join(workspaceRoot, 'apps/api/project.json'), 'utf8')) as { targets: Record<string, { executor: string, options: Record<string, unknown> }> }
    expect(project.targets.build.executor).toBe('@nx/esbuild:esbuild')
    expect(project.targets.build.options).toMatchObject({
      outputPath: 'dist/function-apps/api',
      bundle:     true,
      thirdParty: true,
      // Virtual module the Functions host injects at run time; a CJS bundle
      // is what lets its leftover require resolve there.
      external:   ['@azure/functions-core'],
      format:     ['cjs'],
      assets:     expect.arrayContaining([expect.objectContaining({ glob: 'host.json' }), expect.objectContaining({ glob: 'package.json' })]),
    })
    expect(project.targets.start.options).toMatchObject({ command: 'func start', cwd: 'dist/function-apps/api' })
    // The plugin's publish executor shares the same broken build path.
    expect(project.targets).not.toHaveProperty('publish')
    // A hand-rewired app gets no jest from a plugin generator, so wire it here:
    // a self-contained jest run reading the app's own config.
    expect(project.targets.test).toMatchObject({ executor: 'nx:run-commands', options: { command: 'jest', cwd: 'apps/api' } })
    // The package target zips the bundle folder into the drop under the exact
    // name CI turns into a build tag.
    expect(project.targets.package).toMatchObject({ executor: 'nx:run-commands', dependsOn: ['build'], outputs: ['{workspaceRoot}/dist/drop/function-app-api.zip'] })
    expect(project.targets.package.options.command).toContain(`addLocalFolder('dist/function-apps/api')`)
    expect(project.targets.package.options.command).toContain(`writeZip('dist/drop/function-app-api.zip')`)

    const tsconfig = JSON.parse(readFileSync(join(workspaceRoot, 'apps/api/tsconfig.json'), 'utf8')) as { compilerOptions: Record<string, unknown>, exclude: string[] }
    // The TS-solution base is declaration-only; esbuild reads this tsconfig.
    expect(tsconfig.compilerOptions.emitDeclarationOnly).toBe(false)
    expect(tsconfig.compilerOptions.composite).toBe(false)
    expect(tsconfig.compilerOptions.outDir).toBe('dist')
    // Specs are owned by tsconfig.spec.json (which adds the jest globals).
    expect(tsconfig.exclude).toEqual(expect.arrayContaining(['src/**/*.spec.ts']))
  })

  it('wires a self-contained jest setup into the function app (config, spec tsconfig, sample test)', async () => {
    await runAdd('function-app', 'api', {})

    const jestConfig = readFileSync(join(workspaceRoot, 'apps/api/jest.config.mjs'), 'utf8')
    expect(jestConfig).toContain(`displayName: 'api'`)
    expect(jestConfig).toContain('ts-jest')
    // Stays green once the user deletes the sample spec.
    expect(jestConfig).toContain('passWithNoTests: true')

    const specTsconfig = JSON.parse(readFileSync(join(workspaceRoot, 'apps/api/tsconfig.spec.json'), 'utf8')) as { compilerOptions: Record<string, unknown>, include: string[] }
    expect(specTsconfig.compilerOptions.types).toEqual(expect.arrayContaining(['jest']))
    expect(specTsconfig.include).toEqual(expect.arrayContaining(['src/**/*.spec.ts']))

    // A real, dependency-free passing test out of the box (the plugin's hello
    // handler would need @azure/functions mocking).
    expect(readFileSync(join(workspaceRoot, 'apps/api/src/greeting.ts'), 'utf8')).toContain('export function buildGreeting')
    expect(readFileSync(join(workspaceRoot, 'apps/api/src/greeting.spec.ts'), 'utf8')).toContain(`from './greeting'`)
  })

  it('syncs TypeScript project references after adding a project so cross-project imports resolve', async () => {
    await runAdd('react-app', 'web', {})

    // The --preset=ts model resolves cross-project imports via TS references,
    // which nx sync maintains — without this, an editor cannot autocomplete
    // @scope/lib imports until the user runs it by hand.
    expect(mockRunShell).toHaveBeenCalledWith('npx', ['nx', 'sync'], workspaceRoot)
  })

  it('keeps a successful add green even when nx sync fails (the project is already generated)', async () => {
    // Last call in the flow is nx sync; make only it fail.
    mockRunShell.mockImplementation((command: string, arguments_: string[]) => (command === 'npx' && arguments_[0] === 'nx' && arguments_[1] === 'sync' ? 1 : 0))

    await expect(runAdd('react-app', 'web', {})).resolves.toBeUndefined()
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
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ generators: { '@nx/js:library': { linter: 'none', unitTestRunner: 'jest' } } }))

    await runAdd('npm-lib', 'sdk', {})

    const generatorCall = mockRunNx.mock.calls.find((call) => call[0][0] === 'g')
    expect(generatorCall?.[0]).toContain('--linter=none')
    // The dependency-check override is ESLint-specific, so oxlint writes none.
    expect(existsSync(join(workspaceRoot, 'packages/sdk/eslint.config.mjs'))).toBe(false)
  })

  it('passes the vitest runner from nx.json to the react generator', async () => {
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ generators: { '@nx/js:library': { linter: 'eslint', unitTestRunner: 'vitest' } } }))
    mkdirSync(join(workspaceRoot, 'apps/web'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/web/package.json'), JSON.stringify({ name: '@demo/web' }))

    await runAdd('react-app', 'web', {})

    const generatorCall = mockRunNx.mock.calls.find((call) => call[0][1] === '@nx/react:app')
    expect(generatorCall?.[0]).toContain('--unitTestRunner=vitest')
  })

  it('wires the function app to vitest when the workspace chose it', async () => {
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ generators: { '@nx/js:library': { linter: 'eslint', unitTestRunner: 'vitest' } } }))

    await runAdd('function-app', 'api', {})

    // vitest (not jest/ts-jest) is installed, and the config + target follow.
    expect(mockRunShell).toHaveBeenCalledWith('npm', ['install', '--save-dev', '@nx/esbuild', 'esbuild', 'vitest', 'adm-zip', '--no-audit', '--no-fund'], workspaceRoot)
    expect(existsSync(join(workspaceRoot, 'apps/api/vitest.config.ts'))).toBe(true)
    expect(existsSync(join(workspaceRoot, 'apps/api/jest.config.mjs'))).toBe(false)
    const project = JSON.parse(readFileSync(join(workspaceRoot, 'apps/api/project.json'), 'utf8')) as { targets: Record<string, { options: { command: string } }> }
    expect(project.targets.test.options.command).toBe('vitest run --passWithNoTests')
  })

  it('generates an internal lib under libs/ — buildable (tsc) but marked private', async () => {
    // The generator is mocked, so pre-create the manifest it would have written.
    mkdirSync(join(workspaceRoot, 'libs/utils'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'libs/utils/package.json'), JSON.stringify({ name: '@demo/utils' }))

    await runAdd('internal-lib', 'utils', {})

    expect(mockRunNx).toHaveBeenCalledWith([
      'g', '@nx/js:lib', 'libs/utils',
      '--bundler=tsc',
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
