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
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-add-python-'))
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
  it('adds a Python app: delegates to @mnci/nx-python-pip:application, installs the plugin + tooling, packages the wheel', async () => {
    // The generator is mocked, so pre-create the project.json it would write.
    mkdirSync(join(workspaceRoot, 'apps/svc'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/svc/project.json'), JSON.stringify({ name: 'svc', targets: { lint: {}, test: {}, build: {} } }))

    await runAdd('python-app', 'svc', {})

    // No uv, no hand-authored files — just a Python preflight check.
    expect(mockRunShell).toHaveBeenCalledWith('python3', ['--version'], workspaceRoot)

    // The plugin gets installed (npm, not `nx add` — no nx.json plugins registration needed).
    expect(mockRunShell).toHaveBeenCalledWith('npm', ['install', '--save-dev', '@mnci/nx-python-pip', '--no-audit', '--no-fund'], workspaceRoot)
    // Delegates to the plugin's generator, exactly like every other kind.
    expect(mockRunNx).toHaveBeenCalledWith(['g', '@mnci/nx-python-pip:application', 'svc', '--directory=apps/svc', '--no-interactive'], workspaceRoot)

    // requirements-dev.txt (the fixed toolchain) written once.
    expect(readFileSync(join(workspaceRoot, 'requirements-dev.txt'), 'utf8')).toContain('pytest')
    // No hand-authored pyproject.toml/module — that is entirely the plugin's job.
    expect(() => readFileSync(join(workspaceRoot, 'apps/svc/pyproject.toml'), 'utf8')).toThrow()

    // adm-zip + a package target zipping the built wheel into the drop under the
    // exact name CI turns into a build tag, merged into the plugin-written project.json.
    expect(mockRunShell).toHaveBeenCalledWith('npm', ['install', '--save-dev', 'adm-zip', '--no-audit', '--no-fund'], workspaceRoot)
    const project = JSON.parse(readFileSync(join(workspaceRoot, 'apps/svc/project.json'), 'utf8')) as {
      targets: Record<string, { dependsOn?: string[], outputs?: string[], options: { command: string } }>
    }
    expect(project.targets.lint).toBeDefined()
    expect(project.targets.package.dependsOn).toEqual(['build'])
    expect(project.targets.package.outputs).toEqual(['{workspaceRoot}/dist/drop/python-app-svc.zip'])
    expect(project.targets.package.options.command).toContain(`addLocalFolder('apps/svc/dist')`)
    expect(project.targets.package.options.command).toContain(`writeZip('dist/drop/python-app-svc.zip')`)
  })

  it('adds a Python Azure Function: delegates to @mnci/nx-python-pip:function-application, packages the source zip', async () => {
    mkdirSync(join(workspaceRoot, 'apps/api'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/api/project.json'), JSON.stringify({ name: 'api', targets: { lint: {}, test: {} } }))

    await runAdd('python-function-app', 'api', {})

    expect(mockRunNx).toHaveBeenCalledWith(['g', '@mnci/nx-python-pip:function-application', 'api', '--directory=apps/api', '--no-interactive'], workspaceRoot)

    // The deployable is source (not the wheel): mnci's own package target zips
    // the files the plugin's generator would have written.
    const project = JSON.parse(readFileSync(join(workspaceRoot, 'apps/api/project.json'), 'utf8')) as {
      targets: Record<string, { outputs?: string[], options: { command: string } }>
    }
    expect(project.targets.package.outputs).toEqual(['{workspaceRoot}/dist/drop/python-function-app-api.zip'])
    expect(project.targets.package.options.command).toContain(`addLocalFile('apps/api/function_app.py')`)
    expect(project.targets.package.options.command).toContain(`addLocalFolder('apps/api/api','api')`)
    expect(project.targets.package.options.command).toContain(`writeZip('dist/drop/python-function-app-api.zip')`)
  })

  it('adds a publishable Python lib: delegates to @mnci/nx-python-pip:library, no post-generation merge needed', async () => {
    await runAdd('python-lib', 'shared', {})

    expect(mockRunNx).toHaveBeenCalledWith(['g', '@mnci/nx-python-pip:library', 'shared', '--directory=python-packages/shared', '--no-interactive'], workspaceRoot)
    // The plugin's own generator wires nx-release-publish + versionActions —
    // mnci does no post-generation file writing for this kind at all.
    expect(() => readFileSync(join(workspaceRoot, 'python-packages/shared/project.json'), 'utf8')).toThrow()
  })

  it('adds a private Python lib under libs/: delegates to @mnci/nx-python-pip:internal-library', async () => {
    await runAdd('python-internal-lib', 'core', {})

    expect(mockRunNx).toHaveBeenCalledWith(['g', '@mnci/nx-python-pip:internal-library', 'core', '--directory=libs/core', '--no-interactive'], workspaceRoot)
  })

  it('fails fast when Python is not installed', async () => {
    mockRunShell.mockImplementation((command: string) => (command === 'python3' || command === 'python' ? 1 : 0))

    await expect(runAdd('python-app', 'svc', {})).rejects.toThrow('Python not found')
    expect(mockRunNx).not.toHaveBeenCalled()
  })

  it('does not reinstall the plugin when already present', async () => {
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@demo/source', devDependencies: { '@mnci/nx-python-pip': '^0.1.0' } }))

    await runAdd('python-internal-lib', 'core', {})

    expect(mockRunShell).not.toHaveBeenCalledWith('npm', ['install', '--save-dev', '@mnci/nx-python-pip', '--no-audit', '--no-fund'], workspaceRoot)
  })

  it('honours MNCI2_PYTHON_PIP_SPEC to install a local build instead of the published package (used by the e2e suite)', async () => {
    process.env.MNCI2_PYTHON_PIP_SPEC = '/tmp/mnci-nx-python-pip-0.1.0.tgz'
    try {
      await runAdd('python-internal-lib', 'core', {})

      expect(mockRunShell).toHaveBeenCalledWith('npm', ['install', '--save-dev', '/tmp/mnci-nx-python-pip-0.1.0.tgz', '--no-audit', '--no-fund'], workspaceRoot)
    } finally {
      delete process.env.MNCI2_PYTHON_PIP_SPEC
    }
  })

  it('does not overwrite an existing requirements-dev.txt (user edits survive repeat adds)', async () => {
    writeFileSync(join(workspaceRoot, 'requirements-dev.txt'), 'build\ntwine\nruff\npytest\nsome-extra-tool\n')

    await runAdd('python-internal-lib', 'core', {})

    expect(readFileSync(join(workspaceRoot, 'requirements-dev.txt'), 'utf8')).toContain('some-extra-tool')
  })
})
