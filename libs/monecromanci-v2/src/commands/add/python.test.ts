jest.mock('../../nx', () => ({
  runNx:    jest.fn(),
  runShell: jest.fn(() => 0),
}))
jest.mock('../../prompts', () => ({ promptText: jest.fn() }))
jest.mock('@inquirer/prompts', () => ({ select: jest.fn(), input: jest.fn() }))

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runNx, runShell } from '../../nx'
import { runAdd } from '../add'

const mockRunNx = jest.mocked(runNx)
const mockRunShell = jest.mocked(runShell)

let workspaceRoot: string

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci2-add-python-'))
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

describe('runAdd python', () => {
  it('adds a Python app: installs+registers @nxlv/python (uv), generates ruff+pytest, packages the wheel', async () => {
    // The generator is mocked, so pre-create the project.json it would write.
    mkdirSync(join(workspaceRoot, 'apps/svc'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/svc/project.json'), JSON.stringify({ name: 'svc', sourceRoot: 'apps/svc/svc', targets: { build: {} } }))

    await runAdd('python-app', 'svc', {})

    // Plugin installed and registered in nx.json with the uv package manager.
    expect(mockRunNx).toHaveBeenCalledWith(['add', '@nxlv/python'], workspaceRoot)
    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as { plugins: unknown[] }
    expect(nxJson.plugins).toContainEqual({ plugin: '@nxlv/python', options: { packageManager: 'uv' } })

    // Generated with the fixed Python toolchain (no stack knob).
    expect(mockRunNx).toHaveBeenCalledWith([
      'g', '@nxlv/python:uv-project', 'svc',
      '--directory=apps/svc',
      '--projectType=application',
      '--linter=ruff',
      '--unitTestRunner=pytest',
      '--buildSystem=hatch',
      '--no-interactive',
    ], workspaceRoot)

    // adm-zip + a package target zipping the built wheel into the drop under the
    // exact name CI turns into a build tag.
    expect(mockRunShell).toHaveBeenCalledWith('npm', ['install', '--save-dev', 'adm-zip', '--no-audit', '--no-fund'], workspaceRoot)
    const project = JSON.parse(readFileSync(join(workspaceRoot, 'apps/svc/project.json'), 'utf8')) as { targets: Record<string, { dependsOn?: string[], outputs: string[], options: { command?: string, outputPath?: string } }> }
    expect(project.targets.package.dependsOn).toEqual(['build'])
    expect(project.targets.package.outputs).toEqual(['{workspaceRoot}/dist/drop/python-app-svc.zip'])
    expect(project.targets.package.options.command).toContain('addLocalFolder(\'dist/apps/svc\')')
    expect(project.targets.package.options.command).toContain('writeZip(\'dist/drop/python-app-svc.zip\')')

    // The build target's wheel output is redirected to the workspace-root dist/
    // (standardized across every project kind) rather than the project-local one.
    expect(project.targets.build.outputs).toEqual(['{workspaceRoot}/dist/apps/svc'])
    expect(project.targets.build.options.outputPath).toBe('{workspaceRoot}/dist/apps/svc')
  })

  it('adds a Python Azure Function: writes the v2 files + a tested helper, packages the source zip', async () => {
    mkdirSync(join(workspaceRoot, 'apps/api/api'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'apps/api/tests'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/api/project.json'), JSON.stringify({ name: 'api', sourceRoot: 'apps/api/api', targets: {} }))

    await runAdd('python-function-app', 'api', {})

    const generatorCall = mockRunNx.mock.calls.find((call) => call[0][1] === '@nxlv/python:uv-project')
    expect(generatorCall?.[0]).toContain('--directory=apps/api')
    expect(generatorCall?.[0]).toContain('--projectType=application')

    // Azure Functions v2 programming model, importing the tested module helper.
    const functionApp = readFileSync(join(workspaceRoot, 'apps/api/function_app.py'), 'utf8')
    expect(functionApp).toContain('func.FunctionApp(')
    expect(functionApp).toContain('from api.greeting import build_greeting')
    expect(readFileSync(join(workspaceRoot, 'apps/api/host.json'), 'utf8')).toContain('extensionBundle')
    expect(readFileSync(join(workspaceRoot, 'apps/api/requirements.txt'), 'utf8')).toContain('azure-functions')
    // A pure, dependency-free helper + test so pytest is green out of the box.
    expect(readFileSync(join(workspaceRoot, 'apps/api/api/greeting.py'), 'utf8')).toContain('def build_greeting')
    expect(readFileSync(join(workspaceRoot, 'apps/api/tests/test_greeting.py'), 'utf8')).toContain('from api.greeting import build_greeting')

    // The deployable is source (not the wheel): package zips those files.
    const project = JSON.parse(readFileSync(join(workspaceRoot, 'apps/api/project.json'), 'utf8')) as { targets: Record<string, { outputs: string[], options: { command?: string, outputPath?: string } }> }
    expect(project.targets.package.outputs).toEqual(['{workspaceRoot}/dist/drop/python-function-app-api.zip'])
    expect(project.targets.package.options.command).toContain('addLocalFile(\'apps/api/function_app.py\')')
    expect(project.targets.package.options.command).toContain('addLocalFolder(\'apps/api/api\',\'api\')')
    expect(project.targets.package.options.command).toContain('writeZip(\'dist/drop/python-function-app-api.zip\')')

    // The (unused-by-package, but still generator-written) build target is
    // redirected the same way as every other Python kind, for consistency.
    expect(project.targets.build.outputs).toEqual(['{workspaceRoot}/dist/apps/api'])
    expect(project.targets.build.options.outputPath).toBe('{workspaceRoot}/dist/apps/api')
  })

  it('adds a publishable Python lib under python-packages/ (release hook + versionActions come from the plugin), wheel output redirected to root dist/', async () => {
    // The generator is mocked, so pre-create the project.json it would write.
    mkdirSync(join(workspaceRoot, 'python-packages/shared'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'python-packages/shared/project.json'), JSON.stringify({ name: 'shared', targets: { build: { options: { outputPath: '{projectRoot}/dist' } } } }))

    await runAdd('python-lib', 'shared', {})

    // --publishable makes the plugin stamp nx-release-publish + versionActions,
    // so the shared `nx release` versions/tags/publishes it — no custom target.
    expect(mockRunNx).toHaveBeenCalledWith([
      'g', '@nxlv/python:uv-project', 'shared',
      '--directory=python-packages/shared',
      '--projectType=library',
      '--publishable',
      '--linter=ruff',
      '--unitTestRunner=pytest',
      '--buildSystem=hatch',
      '--no-interactive',
    ], workspaceRoot)

    // Unlike npm-lib, a Python wheel's contents don't depend on where the
    // built artifact file lives, so the publishable lib's wheel is
    // standardized to root dist/ same as every other kind.
    const project = JSON.parse(readFileSync(join(workspaceRoot, 'python-packages/shared/project.json'), 'utf8')) as { targets: { build: { outputs: string[], options: { outputPath: string } } } }
    expect(project.targets.build.outputs).toEqual(['{workspaceRoot}/dist/python-packages/shared'])
    expect(project.targets.build.options.outputPath).toBe('{workspaceRoot}/dist/python-packages/shared')
  })

  it('adds a private Python lib under libs/ — a library, never publishable, build output redirected to root dist/', async () => {
    mkdirSync(join(workspaceRoot, 'libs/core'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'libs/core/project.json'), JSON.stringify({ name: 'core', targets: { build: { options: { outputPath: '{projectRoot}/dist' } } } }))

    await runAdd('python-internal-lib', 'core', {})

    const generatorCall = mockRunNx.mock.calls.find((call) => call[0][1] === '@nxlv/python:uv-project')
    expect(generatorCall?.[0]).toEqual([
      'g', '@nxlv/python:uv-project', 'core',
      '--directory=libs/core',
      '--projectType=library',
      '--linter=ruff',
      '--unitTestRunner=pytest',
      '--buildSystem=hatch',
      '--no-interactive',
    ])
    expect(generatorCall?.[0]).not.toContain('--publishable')

    const project = JSON.parse(readFileSync(join(workspaceRoot, 'libs/core/project.json'), 'utf8')) as { targets: { build: { outputs: string[], options: { outputPath: string } } } }
    expect(project.targets.build.outputs).toEqual(['{workspaceRoot}/dist/libs/core'])
    expect(project.targets.build.options.outputPath).toBe('{workspaceRoot}/dist/libs/core')
  })

  it('fails fast when uv is not installed', async () => {
    mockRunShell.mockImplementation((command: string) => (command === 'uv' ? 1 : 0))

    await expect(runAdd('python-app', 'svc', {})).rejects.toThrow('uv not found')
    expect(mockRunNx).not.toHaveBeenCalled()
  })

  it('does not reinstall or duplicate the @nxlv/python plugin when already set up', async () => {
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@demo/source', devDependencies: { '@nxlv/python': '^22.0.0' } }))
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ plugins: [{ plugin: '@nxlv/python', options: { packageManager: 'uv' } }] }))
    mkdirSync(join(workspaceRoot, 'libs/core'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'libs/core/project.json'), JSON.stringify({ name: 'core', targets: {} }))

    await runAdd('python-internal-lib', 'core', {})

    expect(mockRunNx).not.toHaveBeenCalledWith(['add', '@nxlv/python'], workspaceRoot)
    const nxJson = JSON.parse(readFileSync(join(workspaceRoot, 'nx.json'), 'utf8')) as { plugins: unknown[] }
    expect(nxJson.plugins).toHaveLength(1)
  })
})
