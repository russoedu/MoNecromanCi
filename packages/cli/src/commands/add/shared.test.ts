jest.mock('../../nx', () => ({
  runNx: jest.fn(),
  runFormatter: jest.fn(),
  runShell: jest.fn(() => 0)
}))

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runShell } from '../../nx'
import {
  registerProjectCommands,
  relocateRootRuntimeDependencies,
  removeGeneratedEslintConfig,
  rootRuntimeDependencies
} from './shared'

const mockRunShell = jest.mocked(runShell)

let workspaceRoot: string

/** Reads the root package.json's scripts back. */
function scripts (): Record<string, string> {
  return (
    JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
  ).scripts
}

/** Reads the .code-workspace file's tasks array back. */
function tasks (): Record<string, unknown>[] {
  return (
    JSON.parse(readFileSync(join(workspaceRoot, 'demo.code-workspace'), 'utf8')) as {
      tasks: { version: string; tasks: Record<string, unknown>[] }
    }
  ).tasks.tasks
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-shared-'))
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@demo/source' }))
  mockRunShell.mockImplementation(() => 0)
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('registerProjectCommands', () => {
  it('always writes <name>:qa, and <name>:build/:start only when the kind has them', () => {
    registerProjectCommands(workspaceRoot, 'lib', { build: true })
    expect(scripts()['lib:qa']).toBe('nx run lib:lint && nx run lib:test')
    expect(scripts()['lib:build']).toBe('nx run lib:build')
    expect(scripts()['lib:start']).toBeUndefined()

    registerProjectCommands(workspaceRoot, 'internal', { build: false })
    expect(scripts()['internal:qa']).toBe('nx run internal:lint && nx run internal:test')
    expect(scripts()['internal:build']).toBeUndefined()
    expect(scripts()['internal:start']).toBeUndefined()

    registerProjectCommands(workspaceRoot, 'app', { build: true, start: 'nx run app:serve' })
    expect(scripts()['app:build']).toBe('nx run app:build')
    expect(scripts()['app:start']).toBe('nx run app:serve')
  })

  it('preserves scripts already in package.json (both mnci-owned and hand-added)', () => {
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({
        name: '@demo/source',
        scripts: { lint: 'nx run-many -t lint', mine: 'echo hi' }
      })
    )

    registerProjectCommands(workspaceRoot, 'web', { build: true })

    expect(scripts().lint).toBe('nx run-many -t lint')
    expect(scripts().mine).toBe('echo hi')
    expect(scripts()['web:build']).toBe('nx run web:build')
  })

  it('overwrites rather than duplicates on a repeat call for the same project', () => {
    registerProjectCommands(workspaceRoot, 'web', { build: false })
    expect(scripts()['web:build']).toBeUndefined()

    registerProjectCommands(workspaceRoot, 'web', { build: true, start: 'nx run web:serve' })
    expect(Object.keys(scripts()).filter(key => key.startsWith('web:'))).toHaveLength(3)
    expect(scripts()['web:build']).toBe('nx run web:build')
    expect(scripts()['web:start']).toBe('nx run web:serve')
  })

  it('skips the VS Code half entirely when no .code-workspace file exists', () => {
    expect(() => registerProjectCommands(workspaceRoot, 'web', { build: true })).not.toThrow()
  })

  it('tolerates a .code-workspace file Prettier has reformatted with trailing commas (its own JSONC dialect)', () => {
    // Verified empirically: Prettier 3.9 has native .code-workspace support
    // and reformats a single-entry array with a trailing comma, which
    // strict JSON.parse rejects. `npm run format` is part of mnci's own
    // documented pre-commit routine, so this must not break the next `add`.
    writeFileSync(
      join(workspaceRoot, 'demo.code-workspace'),
      '{\n  "folders": [\n    {\n      "path": ".",\n      "name": "demo",\n    },\n  ],\n  "tasks": { "version": "2.0.0", "tasks": [] },\n}\n'
    )

    expect(() => registerProjectCommands(workspaceRoot, 'web', { build: true })).not.toThrow()
    expect(tasks()).toEqual([
      { label: 'web: qa', type: 'npm', script: 'web:qa', problemMatcher: [], group: 'qa' },
      { label: 'web: build', type: 'npm', script: 'web:build', problemMatcher: [], group: 'build' }
    ])
  })

  it('appends matching VS Code tasks, grouped by build/test and isBackground for start', () => {
    writeFileSync(
      join(workspaceRoot, 'demo.code-workspace'),
      JSON.stringify({ folders: [], tasks: { version: '2.0.0', tasks: [] } })
    )

    registerProjectCommands(workspaceRoot, 'web', { build: true, start: 'nx run web:serve' })

    expect(tasks()).toEqual([
      { label: 'web: qa', type: 'npm', script: 'web:qa', problemMatcher: [], group: 'qa' },
      { label: 'web: build', type: 'npm', script: 'web:build', problemMatcher: [], group: 'build' },
      {
        label: 'web: start',
        type: 'npm',
        script: 'web:start',
        problemMatcher: [],
        isBackground: true
      }
    ])
  })

  it("replaces a project's own tasks on a repeat call without touching another project's", () => {
    writeFileSync(
      join(workspaceRoot, 'demo.code-workspace'),
      JSON.stringify({ folders: [], tasks: { version: '2.0.0', tasks: [] } })
    )
    registerProjectCommands(workspaceRoot, 'lib', { build: true })
    registerProjectCommands(workspaceRoot, 'web', { build: false })

    registerProjectCommands(workspaceRoot, 'web', { build: true, start: 'nx run web:serve' })

    const labels = tasks().map(task => task.label)
    expect(labels).toEqual(['lib: qa', 'lib: build', 'web: qa', 'web: build', 'web: start'])
  })

  it('defaults a .code-workspace file with no tasks block to version 2.0.0', () => {
    writeFileSync(join(workspaceRoot, 'demo.code-workspace'), JSON.stringify({ folders: [] }))

    registerProjectCommands(workspaceRoot, 'web', { build: true })

    const workspaceFile = JSON.parse(
      readFileSync(join(workspaceRoot, 'demo.code-workspace'), 'utf8')
    ) as { tasks: { version: string } }
    expect(workspaceFile.tasks.version).toBe('2.0.0')
  })
})

describe('removeGeneratedEslintConfig', () => {
  /** Every extension Nx can pick, driven off the module type of the project. */
  const EXTENSIONS = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts']

  it('removes a generated config whatever extension Nx chose for it', () => {
    // Nx picks the extension from the project's module type, so a helper that
    // only knew about `.mjs` would silently leave a second config behind for
    // some kinds — exactly the fragmentation this exists to prevent.
    mkdirSync(join(workspaceRoot, 'apps/web'), { recursive: true })
    for (const extension of EXTENSIONS) {
      writeFileSync(join(workspaceRoot, `apps/web/eslint.config.${extension}`), 'export default []')
    }

    removeGeneratedEslintConfig(workspaceRoot, 'apps/web')

    for (const extension of EXTENSIONS) {
      expect(existsSync(join(workspaceRoot, `apps/web/eslint.config.${extension}`))).toBe(false)
    }
  })

  it('removes the .vscode directory @nx/node re-creates, which the .code-workspace file replaces', () => {
    // `mnci new` deletes this once, but @nx/node writes a launch.json on every
    // add — so cleaning up only at creation time would not hold.
    mkdirSync(join(workspaceRoot, '.vscode'), { recursive: true })
    writeFileSync(join(workspaceRoot, '.vscode/launch.json'), '{}')

    removeGeneratedEslintConfig(workspaceRoot, 'apps/web')

    expect(existsSync(join(workspaceRoot, '.vscode'))).toBe(false)
  })

  it('is a no-op when the generator wrote neither, rather than throwing', () => {
    // Not every kind's generator emits an eslint config; the call site is
    // unconditional, so a missing path must not fail the whole add.
    expect(() => {
      removeGeneratedEslintConfig(workspaceRoot, 'apps/nothing-here')
    }).not.toThrow()
  })

  it('leaves the root config alone — that is the one config an mnci workspace keeps', () => {
    writeFileSync(join(workspaceRoot, 'eslint.config.mjs'), 'export default []')
    mkdirSync(join(workspaceRoot, 'apps/web'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/web/eslint.config.mjs'), 'export default []')

    removeGeneratedEslintConfig(workspaceRoot, 'apps/web')

    expect(existsSync(join(workspaceRoot, 'eslint.config.mjs'))).toBe(true)
  })
})

/** Writes a root manifest with the given runtime dependencies. */
function writeRoot (dependencies: Record<string, string> | undefined): void {
  writeFileSync(
    join(workspaceRoot, 'package.json'),
    JSON.stringify({ name: '@demo/source', private: true, ...(dependencies && { dependencies }) })
  )
}

/** Creates a project manifest under the given root directory. */
function writeProject (
  root: string,
  name: string,
  manifest: Record<string, unknown> = {}
): string {
  mkdirSync(join(workspaceRoot, root, name), { recursive: true })
  const path = join(workspaceRoot, root, name, 'package.json')
  writeFileSync(path, JSON.stringify({ name: `@demo/${name}`, ...manifest }))
  return path
}

/** Reads a manifest's dependencies back. */
function deps (path: string): Record<string, string> | undefined {
  return (
    JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, string> }
  ).dependencies
}

describe('relocateRootRuntimeDependencies', () => {
  it('moves what the generator added into the project, leaving the root with none', () => {
    const before = rootRuntimeDependencies(workspaceRoot)
    writeRoot({ react: '^19.0.0', 'react-dom': '^19.0.0' })
    const project = writeProject('apps', 'web')

    relocateRootRuntimeDependencies(workspaceRoot, 'web', before)

    expect(deps(project)).toEqual({ react: '^19.0.0', 'react-dom': '^19.0.0' })
    // The doctor check this exists to satisfy reads `dependencies` and requires
    // it empty, so the key is dropped rather than left as {}.
    expect(deps(join(workspaceRoot, 'package.json'))).toBeUndefined()
  })

  it('leaves dependencies that were already there before the generator ran', () => {
    writeRoot({ ms: '^2.1.3' })
    const before = rootRuntimeDependencies(workspaceRoot)
    writeRoot({ ms: '^2.1.3', express: '^5.0.0' })
    const project = writeProject('apps', 'svc')

    relocateRootRuntimeDependencies(workspaceRoot, 'svc', before)

    expect(deps(project)).toEqual({ express: '^5.0.0' })
    expect(deps(join(workspaceRoot, 'package.json'))).toEqual({ ms: '^2.1.3' })
  })

  it("keeps the project's own version when it already declares the package", () => {
    // `add node-function-app` stamps the exact installed version into the app
    // manifest; the root's range is looser, so the root must not win.
    const before = rootRuntimeDependencies(workspaceRoot)
    writeRoot({ '@azure/functions': '^4.0.0' })
    const project = writeProject('apps', 'api', {
      dependencies: { '@azure/functions': '^4.16.2' }
    })

    relocateRootRuntimeDependencies(workspaceRoot, 'api', before)

    expect(deps(project)).toEqual({ '@azure/functions': '^4.16.2' })
    expect(deps(join(workspaceRoot, 'package.json'))).toBeUndefined()
  })

  it('finds the project under packages/ and libs/ too', () => {
    for (const [root, name] of [['packages', 'sdk'], ['libs', 'utils']] as const) {
      const before = rootRuntimeDependencies(workspaceRoot)
      writeRoot({ ms: '^2.1.3' })
      const project = writeProject(root, name)
      relocateRootRuntimeDependencies(workspaceRoot, name, before)
      expect(deps(project)).toEqual({ ms: '^2.1.3' })
    }
  })

  it('leaves the root alone when the project has no npm manifest', () => {
    // A Python, Go or Dart project has nothing to move them into. Dropping the
    // declaration would break resolution for whatever does need it.
    const before = rootRuntimeDependencies(workspaceRoot)
    writeRoot({ ms: '^2.1.3' })
    mkdirSync(join(workspaceRoot, 'apps/pysvc'), { recursive: true })

    relocateRootRuntimeDependencies(workspaceRoot, 'pysvc', before)

    expect(deps(join(workspaceRoot, 'package.json'))).toEqual({ ms: '^2.1.3' })
  })

  it('refreshes the lockfile, because moving a dependency leaves it stale', () => {
    const before = rootRuntimeDependencies(workspaceRoot)
    writeRoot({ ms: '^2.1.3' })
    writeProject('apps', 'svc')

    relocateRootRuntimeDependencies(workspaceRoot, 'svc', before)

    expect(mockRunShell).toHaveBeenCalledWith(
      'npm',
      ['install', '--package-lock-only', '--no-audit', '--no-fund'],
      workspaceRoot
    )
  })

  it('does nothing at all when the generator added no runtime dependency', () => {
    writeRoot({ ms: '^2.1.3' })
    const before = rootRuntimeDependencies(workspaceRoot)
    writeProject('apps', 'svc')

    relocateRootRuntimeDependencies(workspaceRoot, 'svc', before)

    expect(deps(join(workspaceRoot, 'package.json'))).toEqual({ ms: '^2.1.3' })
    expect(mockRunShell).not.toHaveBeenCalled()
  })

  it('warns rather than throwing when the lockfile refresh fails', () => {
    mockRunShell.mockImplementation(() => 1)
    const before = rootRuntimeDependencies(workspaceRoot)
    writeRoot({ ms: '^2.1.3' })
    const project = writeProject('apps', 'svc')

    expect(() => {
      relocateRootRuntimeDependencies(workspaceRoot, 'svc', before)
    }).not.toThrow()
    // The move still stands — the project is already generated by this point.
    expect(deps(project)).toEqual({ ms: '^2.1.3' })
  })
})
