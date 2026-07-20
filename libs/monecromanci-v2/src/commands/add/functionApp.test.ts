jest.mock('../../nx', () => ({
  runNx:    jest.fn(),
  runShell: jest.fn(() => 0),
}))
jest.mock('../../prompts', () => ({ promptText: jest.fn() }))
jest.mock('@inquirer/prompts', () => ({ select: jest.fn(), input: jest.fn() }))

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runNx, runShell } from '../../nx'
import { runAdd } from '../add'

const mockRunNx = jest.mocked(runNx)
const mockRunShell = jest.mocked(runShell)

let workspaceRoot: string

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci2-add-function-app-'))
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

describe('runAdd function-app', () => {
  it('generates a function app: core-tools preflight, plain install, init with --directory, then new', async () => {
    await runAdd('function-app', 'api', {})

    // Preflight: the generators shell out to the func CLI even at generation time.
    expect(mockRunShell).toHaveBeenNthCalledWith(1, 'func', ['--version'], workspaceRoot)
    // Plain npm install — `nx add` would run the plugin's bare init generator, which requires args and always fails.
    expect(mockRunShell).toHaveBeenNthCalledWith(2, 'npm', ['install', '--save-dev', '@nxazure/func'], workspaceRoot)
    expect(mockRunNx).toHaveBeenNthCalledWith(1, ['g', '@nxazure/func:init', 'api', '--directory=apps/api', '--no-interactive'], workspaceRoot)
    expect(mockRunNx).toHaveBeenNthCalledWith(2, ['g', '@nxazure/func:new', 'hello', '--project=api', '--template=HTTP trigger'], workspaceRoot)
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

  it('fails fast with install instructions when Azure Functions Core Tools is missing', async () => {
    mockRunShell.mockReturnValueOnce(1)

    await expect(runAdd('function-app', 'api', {})).rejects.toThrow('Azure Functions Core Tools not found')
    expect(mockRunNx).not.toHaveBeenCalled()
  })

  it('fails loudly when the @nxazure/func install exits non-zero', async () => {
    mockRunShell.mockReturnValueOnce(0).mockReturnValueOnce(1)

    await expect(runAdd('function-app', 'api', {})).rejects.toThrow('npm install of @nxazure/func failed with exit code 1')
  })

  it('wires the function app to vitest when the workspace chose it', async () => {
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ mnci2: { stack: { linter: 'eslint', testRunner: 'vitest' } } }))

    await runAdd('function-app', 'api', {})

    // vitest (not jest/ts-jest) is installed, and the config + target follow.
    expect(mockRunShell).toHaveBeenCalledWith('npm', ['install', '--save-dev', '@nx/esbuild', 'esbuild', 'vitest', 'adm-zip', '--no-audit', '--no-fund'], workspaceRoot)
    expect(existsSync(join(workspaceRoot, 'apps/api/vitest.config.ts'))).toBe(true)
    expect(existsSync(join(workspaceRoot, 'apps/api/jest.config.mjs'))).toBe(false)
    const project = JSON.parse(readFileSync(join(workspaceRoot, 'apps/api/project.json'), 'utf8')) as { targets: Record<string, { options: { command: string } }> }
    expect(project.targets.test.options.command).toBe('vitest run --passWithNoTests')
  })
})
