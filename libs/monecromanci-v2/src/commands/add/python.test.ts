jest.mock('../../nx', () => ({
  runNx:    jest.fn(),
  runShell: jest.fn(() => 0),
}))
jest.mock('../../prompts', () => ({ promptText: jest.fn() }))
jest.mock('@inquirer/prompts', () => ({ select: jest.fn(), input: jest.fn() }))

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runShell } from '../../nx'
import { runAdd } from '../add'

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
  it('adds a Python app: hand-authored pyproject.toml + project.json, ruff/pytest/build, packages the wheel', async () => {
    await runAdd('python-app', 'svc', {})

    // No plugin, no uv — just a Python preflight check.
    expect(mockRunShell).toHaveBeenCalledWith('python3', ['--version'], workspaceRoot)

    // Shared pip-native tooling written once.
    expect(readFileSync(join(workspaceRoot, 'requirements-dev.txt'), 'utf8')).toContain('pytest')
    expect(readFileSync(join(workspaceRoot, 'tools/python-build.js'), 'utf8')).toContain('python -m build')
    expect(readFileSync(join(workspaceRoot, 'tools/python-version-actions.js'), 'utf8')).toContain('class PythonVersionActions')

    // Hand-authored pyproject.toml, no uv/Poetry section anywhere.
    const pyproject = readFileSync(join(workspaceRoot, 'apps/svc/pyproject.toml'), 'utf8')
    expect(pyproject).toContain('name = "svc"')
    expect(pyproject).toContain('[build-system]')
    expect(pyproject).toContain('packages = ["svc"]')
    expect(pyproject).not.toMatch(/uv|poetry/i)

    expect(readFileSync(join(workspaceRoot, 'apps/svc/svc/__init__.py'), 'utf8')).toContain('def hello')
    expect(readFileSync(join(workspaceRoot, 'apps/svc/tests/test_svc.py'), 'utf8')).toContain('from svc import hello')

    // adm-zip + a package target zipping the built wheel into the drop under the
    // exact name CI turns into a build tag.
    expect(mockRunShell).toHaveBeenCalledWith('npm', ['install', '--save-dev', 'adm-zip', '--no-audit', '--no-fund'], workspaceRoot)
    const project = JSON.parse(readFileSync(join(workspaceRoot, 'apps/svc/project.json'), 'utf8')) as {
      targets: Record<string, { dependsOn?: string[], outputs?: string[], options: { command: string, cwd?: string } }>
    }
    expect(project.targets.lint.options.command).toBe('python3 -m ruff check .')
    expect(project.targets.lint.options.cwd).toBe('apps/svc')
    expect(project.targets.test.options.command).toContain('python3 -m pytest')
    expect(project.targets.build.options.command).toBe('node tools/python-build.js apps/svc')
    expect(project.targets.build.outputs).toEqual(['{workspaceRoot}/apps/svc/dist'])
    expect(project.targets.package.dependsOn).toEqual(['build'])
    expect(project.targets.package.outputs).toEqual(['{workspaceRoot}/dist/drop/python-app-svc.zip'])
    expect(project.targets.package.options.command).toContain(`addLocalFolder('apps/svc/dist')`)
    expect(project.targets.package.options.command).toContain(`writeZip('dist/drop/python-app-svc.zip')`)
  })

  it('adds a Python Azure Function: writes the v2 files + a tested helper, packages the source zip, no build/pyproject', async () => {
    await runAdd('python-function-app', 'api', {})

    // Azure Functions v2 programming model, importing the tested module helper.
    const functionApp = readFileSync(join(workspaceRoot, 'apps/api/function_app.py'), 'utf8')
    expect(functionApp).toContain('func.FunctionApp(')
    expect(functionApp).toContain('from api.greeting import build_greeting')
    expect(readFileSync(join(workspaceRoot, 'apps/api/host.json'), 'utf8')).toContain('extensionBundle')
    expect(readFileSync(join(workspaceRoot, 'apps/api/requirements.txt'), 'utf8')).toContain('azure-functions')
    // A pure, dependency-free helper + test so pytest is green out of the box.
    expect(readFileSync(join(workspaceRoot, 'apps/api/api/greeting.py'), 'utf8')).toContain('def build_greeting')
    expect(readFileSync(join(workspaceRoot, 'apps/api/tests/test_greeting.py'), 'utf8')).toContain('from api.greeting import build_greeting')

    // Source deploy: no pyproject.toml, no build target — just lint/test/package.
    expect(() => readFileSync(join(workspaceRoot, 'apps/api/pyproject.toml'), 'utf8')).toThrow()
    const project = JSON.parse(readFileSync(join(workspaceRoot, 'apps/api/project.json'), 'utf8')) as {
      targets: Record<string, { outputs?: string[], options: { command: string } }>
    }
    expect(project.targets.build).toBeUndefined()
    expect(project.targets.test.options.command).toBe('python3 -m pytest')

    // The deployable is source (not the wheel): package zips those files.
    expect(project.targets.package.outputs).toEqual(['{workspaceRoot}/dist/drop/python-function-app-api.zip'])
    expect(project.targets.package.options.command).toContain(`addLocalFile('apps/api/function_app.py')`)
    expect(project.targets.package.options.command).toContain(`addLocalFolder('apps/api/api','api')`)
    expect(project.targets.package.options.command).toContain(`writeZip('dist/drop/python-function-app-api.zip')`)
  })

  it('adds a publishable Python lib under python-packages/ with a hand-authored twine nx-release-publish target', async () => {
    await runAdd('python-lib', 'shared', {})

    const pyproject = readFileSync(join(workspaceRoot, 'python-packages/shared/pyproject.toml'), 'utf8')
    expect(pyproject).toContain('name = "shared"')
    expect(pyproject).toContain('version = "1.0.0"')

    const project = JSON.parse(readFileSync(join(workspaceRoot, 'python-packages/shared/project.json'), 'utf8')) as {
      projectType: string
      release?:    { version?: { versionActions?: string } }
      targets:     Record<string, { dependsOn?: string[], options: { command: string, cwd?: string } }>
    }
    expect(project.projectType).toBe('library')
    expect(project.targets.build.options.command).toBe('node tools/python-build.js python-packages/shared')
    expect(project.targets['nx-release-publish'].dependsOn).toEqual(['build'])
    expect(project.targets['nx-release-publish'].options.command).toContain('python3 -m twine upload --skip-existing dist/*')
    // Guards against `nx release publish --dry-run`'s appended --dryRun=true,
    // which a plain nx:run-commands target (unlike @nx/js:release-publish)
    // does not otherwise understand and would pass straight to twine.
    expect(project.targets['nx-release-publish'].options.command).toContain('isDryRun')
    expect(project.targets['nx-release-publish'].options.cwd).toBe('python-packages/shared')
    // No packaging target — a lib is released as a wheel, never zipped.
    expect(project.targets.package).toBeUndefined()
    // Project-level versionActions override (wins over the workspace release
    // config's default, since Nx errors the whole release when an explicit
    // release group matches zero projects — see overlay.ts's RELEASE_CONFIG).
    expect(project.release?.version?.versionActions).toBe('tools/python-version-actions.js')
  })

  it('adds a private Python lib under libs/ — lint + test only, no build/publish (vendored by consumers, never released)', async () => {
    await runAdd('python-internal-lib', 'core', {})

    const pyproject = readFileSync(join(workspaceRoot, 'libs/core/pyproject.toml'), 'utf8')
    expect(pyproject).toContain('name = "core"')

    const project = JSON.parse(readFileSync(join(workspaceRoot, 'libs/core/project.json'), 'utf8')) as {
      targets: Record<string, unknown>
    }
    expect(Object.keys(project.targets).toSorted((a, b) => a.localeCompare(b))).toEqual(['lint', 'test'])
  })

  it('fails fast when Python is not installed', async () => {
    mockRunShell.mockImplementation(() => 1)

    await expect(runAdd('python-app', 'svc', {})).rejects.toThrow('Python not found')
  })

  it('does not overwrite an existing requirements-dev.txt (user edits survive repeat adds)', async () => {
    writeFileSync(join(workspaceRoot, 'requirements-dev.txt'), 'build\ntwine\nruff\npytest\nsome-extra-tool\n')

    await runAdd('python-internal-lib', 'core', {})

    expect(readFileSync(join(workspaceRoot, 'requirements-dev.txt'), 'utf8')).toContain('some-extra-tool')
  })
})
