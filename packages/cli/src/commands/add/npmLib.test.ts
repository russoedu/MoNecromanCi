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

/** What the shared rollup configuration generator writes, verbatim. */
const GENERATED_ROLLUP_CONFIG = [
  "const { withNx } = require('@nx/rollup/with-nx');",
  '',
  'module.exports = withNx(',
  '  {',
  "    main: './src/index.ts',",
  "    outputPath: './dist',",
  "    tsConfig: './tsconfig.lib.json',",
  "    compiler: 'swc',",
  '    format: ["esm"],',
  '  },',
  '  {',
  '    // Provide additional rollup configuration here. See: https://rollupjs.org/configuration-options',
  '    // e.g.',
  '    // output: { sourcemap: true },',
  '  }',
  ');'
].join('\n')

// What @nx/js:lib --bundler=rollup actually writes into the manifest.
const seedGeneratedManifest = (): void => {
  writeFileSync(
    join(workspaceRoot, 'packages/sdk/package.json'),
    JSON.stringify({
      name: '@demo/sdk',
      main: './dist/index.esm.js',
      module: './dist/index.esm.js',
      types: './dist/index.esm.d.ts',
      files: ['dist', '!**/*.tsbuildinfo'],
      exports: {
        './package.json': './package.json',
        '.': {
          types: './dist/index.esm.d.ts',
          import: './dist/index.esm.js',
          default: './dist/index.esm.js'
        }
      }
    })
  )
}

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

  it('repoints types at the declaration file the build actually emits', async () => {
    // The generator writes types: ./dist/index.esm.d.ts and its own build never
    // emits that file, so EVERY TypeScript consumer of the published package gets
    // `any` - verified against a real published package, which failed TS7016. The
    // same repair already existed for react-lib; npm-lib called the same generator
    // family with the same flag and shipped the defect for lack of one line.
    seedGeneratedManifest()

    await runAdd('npm-lib', 'sdk', {})

    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, 'packages/sdk/package.json'), 'utf8')
    ) as { types: string; exports: Record<string, { types?: string }> }
    expect(manifest.types).toBe('./dist/src/index.d.ts')
    expect(manifest.exports['.'].types).toBe('./dist/src/index.d.ts')
  })

  it('leaves main and module alone — index.esm.js IS emitted, only the types path is wrong', async () => {
    seedGeneratedManifest()

    await runAdd('npm-lib', 'sdk', {})

    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, 'packages/sdk/package.json'), 'utf8')
    ) as { main: string; module: string }
    expect(manifest.main).toBe('./dist/index.esm.js')
    expect(manifest.module).toBe('./dist/index.esm.js')
  })

  it('keeps declaration maps out of the published tarball', async () => {
    // declarationMap is on workspace-wide and earns its keep inside the monorepo,
    // but `files: ["dist"]` ships no sources for the maps to point at. Measured on a
    // real published library: 32 of 67 files were .d.ts.map, every one referencing
    // ../src/*.ts, which is not in the tarball.
    seedGeneratedManifest()

    await runAdd('npm-lib', 'sdk', {})

    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, 'packages/sdk/package.json'), 'utf8')
    ) as { files: string[] }
    expect(manifest.files).toContain('!**/*.d.ts.map')
    // The generator entries survive.
    expect(manifest.files).toContain('dist')
    expect(manifest.files).toContain('!**/*.tsbuildinfo')
  })

  it('adds a plugin that repairs the declaration stub the build emits', async () => {
    // @nx/rollup builds the stub's specifier with path.relative(), an OS-native
    // path, so on Windows dist/index.d.ts reads `export * from "./src\index"` -
    // not a valid module specifier anywhere. Verified against a real build: the
    // stub comes out as "./src/index" with the plugin in place.
    writeFileSync(
      join(workspaceRoot, 'packages/sdk/rollup.config.cjs'),
      GENERATED_ROLLUP_CONFIG
    )

    await runAdd('npm-lib', 'sdk', {})

    const config = readFileSync(
      join(workspaceRoot, 'packages/sdk/rollup.config.cjs'),
      'utf8'
    )
    expect(config).toContain('mnci-normalise-declaration-specifiers')
    // The placeholder it replaced is gone, and the rest of the config survives.
    expect(config).not.toContain('Provide additional rollup configuration here')
    expect(config).toContain("main: './src/index.ts'")
    // No backslash literal in the emitted plugin - the separator is built from
    // char codes precisely so there is no escaping here to get wrong.
    expect(config).toContain('String.fromCharCode(92, 92)')
  })

  it('leaves a rollup config it does not recognise alone', async () => {
    // Guarded on the exact placeholder the generators write, so an upstream change
    // to their template makes this a no-op rather than corrupting the config.
    const hand = '// hand-written config\nmodule.exports = {}\n'
    writeFileSync(join(workspaceRoot, 'packages/sdk/rollup.config.cjs'), hand)

    await runAdd('npm-lib', 'sdk', {})

    expect(readFileSync(join(workspaceRoot, 'packages/sdk/rollup.config.cjs'), 'utf8')).toBe(hand)
  })

  it('leaves an already-correct types path untouched, so an upstream fix is not undone', async () => {
    writeFileSync(
      join(workspaceRoot, 'packages/sdk/package.json'),
      JSON.stringify({ name: '@demo/sdk', types: './dist/src/index.d.ts', files: ['dist'] })
    )

    await runAdd('npm-lib', 'sdk', {})

    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, 'packages/sdk/package.json'), 'utf8')
    ) as { types: string }
    expect(manifest.types).toBe('./dist/src/index.d.ts')
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
