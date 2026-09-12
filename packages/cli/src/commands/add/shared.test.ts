jest.mock('../../nx', () => ({
  runNx:        jest.fn(),
  runFormatter: jest.fn(),
  runShell:     jest.fn(() => 0),
}))

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runShell } from '../../nx'
import {
  canRepairRollupConfig,
  hasRollupSourceMaps,
  registerProjectCommands,
  relocateRootRuntimeDependencies,
  removeGeneratedEslintConfig,
  resolveRollupConfigText,
  rootRuntimeDependencies,
  withRollupSourceMaps,
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

/** Reads the .code-workspace file's launch configurations array back. */
function launchConfigs (): Record<string, unknown>[] {
  return (
    JSON.parse(readFileSync(join(workspaceRoot, 'demo.code-workspace'), 'utf8')) as {
      launch: { version: string; configurations: Record<string, unknown>[] }
    }
  ).launch.configurations
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
        name:    '@demo/source',
        scripts: { lint: 'nx run-many -t lint', mine: 'echo hi' },
      }),
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
      '{\n  "folders": [\n    {\n      "path": ".",\n      "name": "demo",\n    },\n  ],\n  "tasks": { "version": "2.0.0", "tasks": [] },\n}\n',
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
      JSON.stringify({ folders: [], tasks: { version: '2.0.0', tasks: [] } }),
    )

    registerProjectCommands(workspaceRoot, 'web', { build: true, start: 'nx run web:serve' })

    expect(tasks()).toEqual([
      { label: 'web: qa', type: 'npm', script: 'web:qa', problemMatcher: [], group: 'qa' },
      { label: 'web: build', type: 'npm', script: 'web:build', problemMatcher: [], group: 'build' },
      {
        label:          'web: start',
        type:           'npm',
        script:         'web:start',
        problemMatcher: [],
        isBackground:   true,
      },
    ])
  })

  it("replaces a project's own tasks on a repeat call without touching another project's", () => {
    writeFileSync(
      join(workspaceRoot, 'demo.code-workspace'),
      JSON.stringify({ folders: [], tasks: { version: '2.0.0', tasks: [] } }),
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
      readFileSync(join(workspaceRoot, 'demo.code-workspace'), 'utf8'),
    ) as { tasks: { version: string } }
    expect(workspaceFile.tasks.version).toBe('2.0.0')
  })

  it('touches nothing outside its own tasks entries — a full-workspace regression test', () => {
    // Reproduces the reported bug: a hand-maintained .code-workspace carrying
    // all five top-level keys, non-empty tasks/launch, AND a comment — the
    // realistic shape of a file VS Code itself has been used to edit, and the
    // exact ingredient (one comment) that used to make readCodeWorkspace
    // throw, discard everything via `?? {}`, and leave only `tasks` behind.
    const before = {
      folders:  [{ path: '.', name: 'demo' }],
      settings: {
        'eslint.validate':         ['javascript', 'typescript'],
        'editor.formatOnSave':     true,
        'editor.defaultFormatter': 'dbaeumer.vscode-eslint',
        'cSpell.words':            ['monecromanci', 'rollup', 'esbuild'],
      },
      extensions: {
        recommendations: [
          'dbaeumer.vscode-eslint',
          'nrwl.angular-console',
          'firsttris.vscode-jest-runner',
        ],
      },
      tasks: {
        version: '2.0.0',
        tasks:   [
          { label: 'lib: qa', type: 'npm', script: 'lib:qa', problemMatcher: [], group: 'qa' },
          {
            label:          'lib: build',
            type:           'npm',
            script:         'lib:build',
            problemMatcher: [],
            group:          'build',
          },
        ],
      },
      launch: {
        version:        '0.2.0',
        configurations: [
          { type: 'node-terminal', request: 'launch', name: 'mnci: build', command: 'npm run build' },
          {
            type:    'node',
            request: 'launch',
            name:    'debug my thing',
            program: '${workspaceFolder:demo}/apps/lib/dist/main.js',
          },
        ],
      },
    }
    writeFileSync(
      join(workspaceRoot, 'demo.code-workspace'),
      [
        '{',
        '  // eslint.validate lists every language ESLint now formats',
        `  "settings": ${JSON.stringify(before.settings)},`,
        `  "folders": ${JSON.stringify(before.folders)},`,
        `  "extensions": ${JSON.stringify(before.extensions)},`,
        `  "tasks": ${JSON.stringify(before.tasks)},`,
        `  "launch": ${JSON.stringify(before.launch)}`,
        '}',
      ].join('\n'),
    )

    registerProjectCommands(workspaceRoot, 'web', { build: true, start: 'nx run web:serve' })

    const after = JSON.parse(readFileSync(join(workspaceRoot, 'demo.code-workspace'), 'utf8')) as {
      folders:    unknown
      settings:   unknown
      extensions: unknown
      launch:     unknown
      tasks:      { version: string; tasks: { label: string }[] }
    }
    // Untouched byte-for-byte (through a parse/re-stringify round trip):
    // `add` owns none of these keys.
    expect(after.folders).toEqual(before.folders)
    expect(after.settings).toEqual(before.settings)
    expect(after.extensions).toEqual(before.extensions)
    expect(after.launch).toEqual(before.launch)
    // The one key `add` does own: the existing project's tasks survive, and
    // the new project's are appended, not substituted for them.
    expect(after.tasks.tasks.map(t => t.label)).toEqual([
      'lib: qa',
      'lib: build',
      'web: qa',
      'web: build',
      'web: start',
    ])
  })

  it('replaces only its own entries on a second add for the same project, matching by label', () => {
    writeFileSync(
      join(workspaceRoot, 'demo.code-workspace'),
      [
        '{',
        '  // hand-added note',
        '  "folders": [{ "path": ".", "name": "demo" }],',
        '  "tasks": { "version": "2.0.0", "tasks": [] }',
        '}',
      ].join('\n'),
    )
    registerProjectCommands(workspaceRoot, 'web', { build: false })

    registerProjectCommands(workspaceRoot, 'web', { build: true, start: 'nx run web:serve' })

    const after = JSON.parse(readFileSync(join(workspaceRoot, 'demo.code-workspace'), 'utf8')) as {
      folders: unknown
      tasks:   { tasks: { label: string }[] }
    }
    expect(after.folders).toEqual([{ path: '.', name: 'demo' }])
    expect(after.tasks.tasks.map(t => t.label)).toEqual(['web: qa', 'web: build', 'web: start'])
  })

  it('writes <name>:build:dev and <name>:dev only when the kind has them', () => {
    registerProjectCommands(workspaceRoot, 'api', {
      build:    true,
      buildDev: 'nx run api:build:development',
      start:    'nx run api:start',
      dev:      'nx run api:dev',
    })

    expect(scripts()['api:build']).toBe('nx run api:build')
    expect(scripts()['api:build:dev']).toBe('nx run api:build:development')
    expect(scripts()['api:start']).toBe('nx run api:start')
    expect(scripts()['api:dev']).toBe('nx run api:dev')

    registerProjectCommands(workspaceRoot, 'lib', { build: true })
    expect(scripts()['lib:build:dev']).toBeUndefined()
    expect(scripts()['lib:dev']).toBeUndefined()
  })

  it('writes a matching VS Code task for build:dev and dev, dev marked isBackground', () => {
    writeFileSync(
      join(workspaceRoot, 'demo.code-workspace'),
      JSON.stringify({ folders: [], tasks: { version: '2.0.0', tasks: [] } }),
    )

    registerProjectCommands(workspaceRoot, 'api', {
      build:    true,
      buildDev: 'nx run api:build:development',
      dev:      'nx run api:dev',
    })

    expect(tasks()).toContainEqual({
      label:          'api: build:dev',
      type:           'npm',
      script:         'api:build:dev',
      problemMatcher: [],
      group:          'build:dev',
    })
    expect(tasks()).toContainEqual({
      label:          'api: dev',
      type:           'npm',
      script:         'api:dev',
      problemMatcher: [],
      isBackground:   true,
    })
  })

  it("writes a per-project 'mnci: <name> dev' launch config only when the kind has dev", () => {
    writeFileSync(
      join(workspaceRoot, 'demo.code-workspace'),
      JSON.stringify({ folders: [{ path: '.', name: 'demo' }], tasks: { version: '2.0.0', tasks: [] } }),
    )

    registerProjectCommands(workspaceRoot, 'api', { build: true, dev: 'nx run api:dev' })
    registerProjectCommands(workspaceRoot, 'lib', { build: true })

    expect(launchConfigs()).toContainEqual({
      type:         'node-terminal',
      request:      'launch',
      name:         'mnci: api dev',
      command:      'npm run api:dev',
      cwd:          '${workspaceFolder:demo}',
      presentation: { group: 'mnci-dev' },
    })
    expect(launchConfigs().some(c => c.name === 'mnci: lib dev')).toBe(false)
  })

  it('replaces only its own dev launch config on a repeat add, leaving others untouched', () => {
    writeFileSync(
      join(workspaceRoot, 'demo.code-workspace'),
      JSON.stringify({
        folders: [{ path: '.', name: 'demo' }],
        tasks:   { version: '2.0.0', tasks: [] },
        launch:  {
          version:        '0.2.0',
          configurations: [
            { type: 'node-terminal', request: 'launch', name: 'mnci: build' },
            { type: 'node', request: 'launch', name: 'debug my thing' },
          ],
        },
      }),
    )

    registerProjectCommands(workspaceRoot, 'api', { build: true, dev: 'nx run api:dev' })
    registerProjectCommands(workspaceRoot, 'api', { build: true, dev: 'nx run api:dev --port=4000' })

    const apiDevConfigs = launchConfigs().filter(c => c.name === 'mnci: api dev')
    expect(apiDevConfigs).toHaveLength(1)
    expect(apiDevConfigs[0].command).toBe('npm run api:dev')
    expect(launchConfigs().map(c => c.name)).toEqual(
      expect.arrayContaining(['mnci: build', 'debug my thing', 'mnci: api dev']),
    )
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
    JSON.stringify({ name: '@demo/source', private: true, ...(dependencies && { dependencies }) }),
  )
}

/** Creates a project manifest under the given root directory. */
function writeProject (
  root: string,
  name: string,
  manifest: Record<string, unknown> = {},
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
    writeRoot({ 'react': '^19.0.0', 'react-dom': '^19.0.0' })
    const project = writeProject('apps', 'web')

    relocateRootRuntimeDependencies(workspaceRoot, 'web', before)

    expect(deps(project)).toEqual({ 'react': '^19.0.0', 'react-dom': '^19.0.0' })
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
      dependencies: { '@azure/functions': '^4.16.2' },
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
      workspaceRoot,
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

describe('hasRollupSourceMaps', () => {
  it('matches the flag exactly as mnci writes it', () => {
    expect(hasRollupSourceMaps('    sourceMap: true,')).toBe(true)
  })

  it('tolerates the whitespace @stylistic/key-spacing (aligned on value) is entitled to add', () => {
    // The reproduction: an object whose longest key is `additionalEntryPoints`
    // gets every value column-aligned, so `sourceMap: true,` becomes
    // `sourceMap:             true,` - still the same flag, only reformatted.
    expect(hasRollupSourceMaps('    sourceMap:             true,')).toBe(true)
    expect(hasRollupSourceMaps('    sourceMap :   true')).toBe(true)
  })

  it('does not match the unrelated lowercase key in the placeholder comment', () => {
    // `// output: { sourcemap: true },` is Nx's own generated comment, and it
    // is genuinely a different key (rollup's own `sourcemap`, all lowercase) -
    // this must stay case-sensitive or every fresh project would read as
    // already fixed before mnci ever touches it.
    expect(hasRollupSourceMaps('    // output: { sourcemap: true },')).toBe(false)
  })

  it('reports false when the flag is genuinely absent', () => {
    expect(hasRollupSourceMaps("    compiler: 'swc',")).toBe(false)
  })
})

describe('canRepairRollupConfig', () => {
  it('is true for a config with the withNx two-argument boundary', () => {
    expect(canRepairRollupConfig('  },\n  {\n\n    format: ["esm"],\n  }\n)')).toBe(true)
  })

  it('is false for a one-line delegation to a shared base, which has no such boundary', () => {
    expect(canRepairRollupConfig("module.exports = require('../../rollup.base.cjs')()\n")).toBe(
      false,
    )
  })
})

describe('withRollupSourceMaps: idempotence after a lint reformat', () => {
  it('does not insert a second sourceMap: true into a config eslint has only reformatted', () => {
    // Reproduces the reported bug end to end: a config that already has source
    // maps on, reformatted by @stylistic/key-spacing (aligned on value) so the
    // flag now carries extra whitespace. A literal-string idempotence guard
    // would fail to recognise it and insert a duplicate flag; the fix is that
    // withRollupSourceMaps and its guard share the same whitespace-tolerant
    // check.
    const reformatted = [
      "const { withNx } = require('@nx/rollup/with-nx');",
      '',
      'module.exports = withNx(',
      '  {',
      "    main:                  './src/index.ts',",
      '    additionalEntryPoints: [],',
      "    outputPath:            './dist',",
      "    tsConfig:              './tsconfig.lib.json',",
      "    compiler:              'babel',",
      '    format:                ["esm"],',
      '    // Added by MoNecromanCI: without this rollup emits no .js.map at all, so',
      '    // a breakpoint in a .ts file can never bind. Not published - see `files`.',
      '    sourceMap:             true',
      '  },',
      '  {',
      '    // Provide additional rollup configuration here. See: https://rollupjs.org/configuration-options',
      '  }',
      ');',
    ].join('\n')

    const after = withRollupSourceMaps(reformatted)

    expect(after).toBe(reformatted)
    expect(after.match(/sourceMap/g)).toHaveLength(1)
  })
})

describe('resolveRollupConfigText', () => {
  it('returns the config text unchanged when it has no local require() at all', () => {
    const config = 'module.exports = withNx({ sourceMap: true }, {})\n'
    writeFileSync(join(workspaceRoot, 'rollup.config.cjs'), config)

    expect(resolveRollupConfigText(join(workspaceRoot, 'rollup.config.cjs'))).toBe(config)
  })

  it('follows a local require() and appends the target file, so the flag one file away is still seen', () => {
    // The other shape from the report: a workspace that hoists the shared
    // withNx() call into one root rollup.base.cjs and leaves each project as
    // a one-line delegation. hasRollupSourceMaps reading only the project's
    // own text finds nothing; reading the resolved text finds it.
    mkdirSync(join(workspaceRoot, 'packages/sdk'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'rollup.base.cjs'),
      [
        "const { withNx } = require('@nx/rollup/with-nx');",
        '',
        'module.exports = () => withNx(',
        '  {',
        "    compiler: 'babel',",
        '    sourceMap: true',
        '  },',
        '  {}',
        ');',
      ].join('\n'),
    )
    writeFileSync(
      join(workspaceRoot, 'packages/sdk/rollup.config.cjs'),
      "module.exports = require('../../rollup.base.cjs')()\n",
    )

    const resolved = resolveRollupConfigText(join(workspaceRoot, 'packages/sdk/rollup.config.cjs'))

    expect(hasRollupSourceMaps(resolved)).toBe(true)
  })

  it('does not follow a require() of an npm package, only a local relative path', () => {
    const config = "const { withNx } = require('@nx/rollup/with-nx');\nmodule.exports = withNx({}, {})\n"
    writeFileSync(join(workspaceRoot, 'rollup.config.cjs'), config)

    // Nothing is appended: the only require() here is a package specifier,
    // which does not start with a dot, so there is nothing local to follow.
    expect(resolveRollupConfigText(join(workspaceRoot, 'rollup.config.cjs'))).toBe(config)
  })

  it('terminates on a require() cycle rather than recursing forever', () => {
    writeFileSync(join(workspaceRoot, 'a.cjs'), "require('./b.cjs')")
    writeFileSync(join(workspaceRoot, 'b.cjs'), "require('./a.cjs')")

    expect(() => resolveRollupConfigText(join(workspaceRoot, 'a.cjs'))).not.toThrow()
  })
})
