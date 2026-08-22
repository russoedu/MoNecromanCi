jest.mock('../../nx', () => ({
  runNx: jest.fn(),
  runFormatter: jest.fn(),
  runShell: jest.fn(() => 0)
}))
jest.mock('../../prompts', () => ({ promptText: jest.fn() }))
jest.mock('@inquirer/prompts', () => ({ select: jest.fn(), input: jest.fn() }))

import { select } from '@inquirer/prompts'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runNx, runFormatter, runShell } from '../../nx'
import { promptText } from '../../prompts'
import { runAdd } from '../add'

const mockRunNx = jest.mocked(runNx)
const mockRunFormatter = jest.mocked(runFormatter)
const mockRunShell = jest.mocked(runShell)
const mockPromptText = jest.mocked(promptText)
const mockSelect = jest.mocked(select)

let workspaceRoot: string

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-add-python-'))
  mockRunShell.mockImplementation(() => 0)
  jest.spyOn(process, 'cwd').mockReturnValue(workspaceRoot)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  writeFileSync(join(workspaceRoot, 'nx.json'), '{}')
  writeFileSync(
    join(workspaceRoot, 'package.json'),
    JSON.stringify({ name: '@demo/source', devDependencies: {} })
  )
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

describe('runAdd python', () => {
  it('adds a Python app: delegates to @mnci/nx-python-pip:application, installs the plugin + tooling, packages the wheel', async () => {
    // The generator is mocked, so pre-create the project.json it would write.
    mkdirSync(join(workspaceRoot, 'apps/svc'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'apps/svc/project.json'),
      JSON.stringify({ name: 'svc', targets: { lint: {}, test: {}, build: {} } })
    )

    await runAdd('python-app', 'svc', {})

    // No uv, no hand-authored files — just a Python preflight check.
    expect(mockRunShell).toHaveBeenCalledWith('python3', ['--version'], workspaceRoot)

    // The plugin gets installed (npm, not `nx add` — no nx.json plugins registration needed).
    expect(mockRunShell).toHaveBeenCalledWith(
      'npm',
      ['install', '--save-dev', '@mnci/nx-python-pip', '--no-audit', '--no-fund'],
      workspaceRoot
    )
    // Delegates to the plugin's generator, exactly like every other kind.
    expect(mockRunNx).toHaveBeenCalledWith(
      ['g', '@mnci/nx-python-pip:application', 'svc', '--directory=apps/svc', '--no-interactive'],
      workspaceRoot
    )

    // requirements-dev.txt (the fixed toolchain) written once.
    expect(readFileSync(join(workspaceRoot, 'requirements-dev.txt'), 'utf8')).toContain('pytest')
    // No hand-authored pyproject.toml/module — that is entirely the plugin's job.
    expect(() => readFileSync(join(workspaceRoot, 'apps/svc/pyproject.toml'), 'utf8')).toThrow()

    // adm-zip + a package target zipping the built wheel into the drop under the
    // exact name CI turns into a build tag, merged into the plugin-written project.json.
    expect(mockRunShell).toHaveBeenCalledWith(
      'npm',
      ['install', '--save-dev', 'adm-zip', '--no-audit', '--no-fund'],
      workspaceRoot
    )
    const project = JSON.parse(
      readFileSync(join(workspaceRoot, 'apps/svc/project.json'), 'utf8')
    ) as {
      targets: Record<
        string,
        { dependsOn?: string[]; outputs?: string[]; options: { command: string } }
      >
    }
    expect(project.targets.lint).toBeDefined()
    expect(project.targets.package.dependsOn).toEqual(['build'])
    expect(project.targets.package.outputs).toEqual([
      '{workspaceRoot}/dist/drop/python-app-svc.zip'
    ])
    expect(project.targets.package.options.command).toContain('addLocalFolder(\'apps/svc/dist\')')
    expect(project.targets.package.options.command).toContain(
      'writeZip(\'dist/drop/python-app-svc.zip\')'
    )

    // A runnable main.py (the plugin's own sample module has no entry point)
    // plus a local `python3 main.py` start target, wired through Nx.
    expect(readFileSync(join(workspaceRoot, 'apps/svc/main.py'), 'utf8')).toContain(
      "if __name__ == '__main__':"
    )
    expect(project.targets.start).toMatchObject({
      executor: 'nx:run-commands',
      continuous: true,
      options: { command: 'python3 main.py', cwd: 'apps/svc' }
    })

    const rootManifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(rootManifest.scripts['svc:build']).toBe('nx run svc:build')
    expect(rootManifest.scripts['svc:qa']).toBe('nx run svc:lint && nx run svc:test')
    expect(rootManifest.scripts['svc:start']).toBe('nx run svc:start')
  })

  it('adds a Python Azure Function: delegates to @mnci/nx-python-pip:function-application, packages the source zip', async () => {
    mkdirSync(join(workspaceRoot, 'apps/api'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'apps/api/project.json'),
      JSON.stringify({ name: 'api', targets: { lint: {}, test: {} } })
    )

    await runAdd('python-function-app', 'api', {})

    expect(mockRunNx).toHaveBeenCalledWith(
      [
        'g',
        '@mnci/nx-python-pip:function-application',
        'api',
        '--directory=apps/api',
        '--no-interactive'
      ],
      workspaceRoot
    )

    // The deployable is source (not the wheel): mnci's own package target zips
    // the files the plugin's generator would have written.
    const project = JSON.parse(
      readFileSync(join(workspaceRoot, 'apps/api/project.json'), 'utf8')
    ) as {
      targets: Record<string, { outputs?: string[]; options: { command: string } }>
    }
    expect(project.targets.package.outputs).toEqual([
      '{workspaceRoot}/dist/drop/python-function-app-api.zip'
    ])
    expect(project.targets.package.options.command).toContain(
      'addLocalFile(\'apps/api/function_app.py\')'
    )
    expect(project.targets.package.options.command).toContain(
      'addLocalFolder(\'apps/api/api\',\'api\')'
    )
    expect(project.targets.package.options.command).toContain(
      'writeZip(\'dist/drop/python-function-app-api.zip\')'
    )

    // A local `func start` needs no prior build here — the source (function_app.py
    // + host.json) is the deployable, unlike node-function-app.
    expect(project.targets.start).toMatchObject({
      executor: 'nx:run-commands',
      continuous: true,
      options: { command: 'func start', cwd: 'apps/api' }
    })
    const rootManifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(rootManifest.scripts['api:start']).toBe('nx run api:start')
    // No build script: a Python function app has no build target at all.
    expect(rootManifest.scripts['api:build']).toBeUndefined()
  })

  it('adds a publishable Python lib: delegates to @mnci/nx-python-pip:library, no post-generation merge needed', async () => {
    await runAdd('python-lib', 'shared', {})

    expect(mockRunNx).toHaveBeenCalledWith(
      [
        'g',
        '@mnci/nx-python-pip:library',
        'shared',
        '--directory=python-packages/shared',
        '--no-interactive'
      ],
      workspaceRoot
    )
    // The plugin's own generator wires nx-release-publish + versionActions —
    // mnci does no post-generation file writing for this kind at all.
    expect(() =>
      readFileSync(join(workspaceRoot, 'python-packages/shared/project.json'), 'utf8')
    ).toThrow()

    const rootManifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(rootManifest.scripts['shared:build']).toBe('nx run shared:build')
    expect(rootManifest.scripts['shared:start']).toBeUndefined()
  })

  it('adds a private Python lib under libs/: delegates to @mnci/nx-python-pip:internal-library', async () => {
    await runAdd('python-internal-lib', 'core', {})

    expect(mockRunNx).toHaveBeenCalledWith(
      [
        'g',
        '@mnci/nx-python-pip:internal-library',
        'core',
        '--directory=libs/core',
        '--no-interactive'
      ],
      workspaceRoot
    )

    // No build target at all for an internal lib (nothing to publish), so no
    // <name>:build script — only :qa.
    const rootManifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(rootManifest.scripts['core:qa']).toBe('nx run core:lint && nx run core:test')
    expect(rootManifest.scripts['core:build']).toBeUndefined()
  })

  it('fails fast when Python is not installed', async () => {
    mockRunShell.mockImplementation((command: string) =>
      command === 'python3' || command === 'python' ? 1 : 0
    )

    await expect(runAdd('python-app', 'svc', {})).rejects.toThrow('Python not found')
    expect(mockRunNx).not.toHaveBeenCalled()
  })

  it('does not reinstall the plugin when already present', async () => {
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: '@demo/source', devDependencies: { '@mnci/nx-python-pip': '^0.1.0' } })
    )

    await runAdd('python-internal-lib', 'core', {})

    expect(mockRunShell).not.toHaveBeenCalledWith(
      'npm',
      ['install', '--save-dev', '@mnci/nx-python-pip', '--no-audit', '--no-fund'],
      workspaceRoot
    )
  })

  it('honours MNCI2_PYTHON_PIP_SPEC to install a local build instead of the published package (used by the e2e suite)', async () => {
    process.env.MNCI2_PYTHON_PIP_SPEC = '/tmp/mnci-nx-python-pip-0.1.0.tgz'
    try {
      await runAdd('python-internal-lib', 'core', {})

      expect(mockRunShell).toHaveBeenCalledWith(
        'npm',
        ['install', '--save-dev', '/tmp/mnci-nx-python-pip-0.1.0.tgz', '--no-audit', '--no-fund'],
        workspaceRoot
      )
    } finally {
      delete process.env.MNCI2_PYTHON_PIP_SPEC
    }
  })

  it('does not overwrite an existing requirements-dev.txt (user edits survive repeat adds)', async () => {
    writeFileSync(
      join(workspaceRoot, 'requirements-dev.txt'),
      'build\ntwine\nruff\npytest\nsome-extra-tool\n'
    )

    await runAdd('python-internal-lib', 'core', {})

    expect(readFileSync(join(workspaceRoot, 'requirements-dev.txt'), 'utf8')).toContain(
      'some-extra-tool'
    )
  })
})

/** A minimal pyproject.toml matching the exact shape `add/python.ts`'s generators write. */
const SAMPLE_PYPROJECT = `[project]
name = "PLACEHOLDER"
version = "1.0.0"
description = ""
requires-python = ">=3.9"
dependencies = []

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["placeholder"]

[tool.pytest.ini_options]
testpaths = ["tests"]
`

describe('runAdd python-vendor', () => {
  beforeEach(() => {
    mkdirSync(join(workspaceRoot, 'apps/svc'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/svc/pyproject.toml'), SAMPLE_PYPROJECT)
    mkdirSync(join(workspaceRoot, 'libs/pycore'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'libs/pycore/pyproject.toml'), SAMPLE_PYPROJECT)
  })

  it("adds a new [tool.mnci-python-pip] vendor table to the consumer's pyproject.toml", async () => {
    await runAdd('python-vendor', 'svc', { lib: 'pycore' })

    const pyproject = readFileSync(join(workspaceRoot, 'apps/svc/pyproject.toml'), 'utf8')
    expect(pyproject).toContain('[tool.mnci-python-pip]\nvendor = ["pycore"]')
    // Inserted before the fixed pytest anchor, not appended blindly at the end.
    expect(pyproject.indexOf('[tool.mnci-python-pip]')).toBeLessThan(
      pyproject.indexOf('[tool.pytest.ini_options]')
    )
    expect(mockRunNx).not.toHaveBeenCalled()
  })

  it('formats the workspace, even though this kind returns early from runAdd', async () => {
    // python-vendor short-circuits before runAdd's shared tail, so its format
    // pass is a second, separate call site — easy to miss, easy to regress.
    await runAdd('python-vendor', 'svc', { lib: 'pycore' })

    expect(mockRunFormatter).toHaveBeenCalledWith(workspaceRoot)
  })

  it('appends to an existing vendor table instead of overwriting it', async () => {
    writeFileSync(
      join(workspaceRoot, 'apps/svc/pyproject.toml'),
      SAMPLE_PYPROJECT.replace(
        '[tool.pytest.ini_options]',
        '[tool.mnci-python-pip]\nvendor = ["other-lib"]\n\n[tool.pytest.ini_options]'
      )
    )
    mkdirSync(join(workspaceRoot, 'libs/pycore'), { recursive: true })

    await runAdd('python-vendor', 'svc', { lib: 'pycore' })

    const pyproject = readFileSync(join(workspaceRoot, 'apps/svc/pyproject.toml'), 'utf8')
    expect(pyproject).toContain('vendor = ["other-lib", "pycore"]')
  })

  it('is idempotent: vendoring the same lib twice does not duplicate the entry', async () => {
    await runAdd('python-vendor', 'svc', { lib: 'pycore' })
    await runAdd('python-vendor', 'svc', { lib: 'pycore' })

    const pyproject = readFileSync(join(workspaceRoot, 'apps/svc/pyproject.toml'), 'utf8')
    expect(pyproject.match(/pycore/g)).toHaveLength(1)
  })

  it('works for any Python project kind, not just apps (publishable and internal libs too)', async () => {
    mkdirSync(join(workspaceRoot, 'python-packages/pyshared'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'python-packages/pyshared/pyproject.toml'), SAMPLE_PYPROJECT)

    await runAdd('python-vendor', 'pyshared', { lib: 'pycore' })

    expect(
      readFileSync(join(workspaceRoot, 'python-packages/pyshared/pyproject.toml'), 'utf8')
    ).toContain('vendor = ["pycore"]')
  })

  it('rejects a consumer with no pyproject.toml (e.g. a Python function app)', async () => {
    await expect(runAdd('python-vendor', 'nonexistent', { lib: 'pycore' })).rejects.toThrow(
      "No Python project named 'nonexistent'"
    )
  })

  it('rejects a lib that is not an internal library under libs/', async () => {
    await expect(runAdd('python-vendor', 'svc', { lib: 'nonexistent-lib' })).rejects.toThrow(
      "No internal Python library named 'nonexistent-lib'"
    )
  })

  it('rejects a project vendoring itself', async () => {
    await expect(runAdd('python-vendor', 'pycore', { lib: 'pycore' })).rejects.toThrow(
      'cannot vendor itself'
    )
  })

  it('requires --lib when the kind was passed explicitly (no silent default, no prompt)', async () => {
    await expect(runAdd('python-vendor', 'svc', {})).rejects.toThrow('needs the library to vendor')
    expect(mockPromptText).not.toHaveBeenCalled()
  })

  it('prompts for the library on the bare/interactive path', async () => {
    mockSelect.mockResolvedValue('python-vendor')
    mockPromptText.mockResolvedValueOnce('svc').mockResolvedValueOnce('pycore')

    await runAdd(undefined, undefined, {})

    expect(mockPromptText).toHaveBeenCalledWith(
      'Internal Python library to vendor (an existing libs/<name>)'
    )
    expect(readFileSync(join(workspaceRoot, 'apps/svc/pyproject.toml'), 'utf8')).toContain(
      'vendor = ["pycore"]'
    )
  })
})
