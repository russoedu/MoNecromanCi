import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerProjectCommands } from './shared'

let workspaceRoot: string

/** Reads the root package.json's scripts back. */
function scripts(): Record<string, string> {
  return (
    JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
  ).scripts
}

/** Reads the .code-workspace file's tasks array back. */
function tasks(): Record<string, unknown>[] {
  return (
    JSON.parse(readFileSync(join(workspaceRoot, 'demo.code-workspace'), 'utf8')) as {
      tasks: { version: string; tasks: Record<string, unknown>[] }
    }
  ).tasks.tasks
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-shared-'))
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@demo/source' }))
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
        scripts: { lint: 'nx run-many -t lint', mine: 'echo hi' },
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
      { label: 'web: build', type: 'npm', script: 'web:build', problemMatcher: [], group: 'build' },
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
        isBackground: true,
      },
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
