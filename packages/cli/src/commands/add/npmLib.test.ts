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
    expect(config).toContain('String.fromCodePoint(92, 92)')
  })

  it('switches source maps on, without which a .ts breakpoint can never bind', async () => {
    // @nx/rollup leaves `sourceMap` undefined, so the build emits no .js.map at
    // all and VS Code greys out every breakpoint. It has to be set in withNx's
    // FIRST argument: the obvious `output: { sourcemap: true }` in the second is
    // silently overridden, because withNx spreads the caller's `output` and then
    // assigns `sourcemap: options.sourceMap` after it.
    writeFileSync(join(workspaceRoot, 'packages/sdk/rollup.config.cjs'), GENERATED_ROLLUP_CONFIG)

    await runAdd('npm-lib', 'sdk', {})

    const config = readFileSync(join(workspaceRoot, 'packages/sdk/rollup.config.cjs'), 'utf8')
    const argumentOne = config.slice(0, config.indexOf('mnci-normalise-declaration-specifiers'))
    expect(argumentOne).toContain('sourceMap: true')
  })

  it('swaps the compiler off swc, without which the maps come out EMPTY', async () => {
    // The half that is easy to miss. @nx/js:lib hardcodes `compiler: 'swc'`, and
    // @nx/rollup's swc plugin calls transform() without sourceMaps - so it
    // returns no map, the chain breaks, and the bundle's map is structurally
    // valid but semantically empty (`sources: []`). Measured on a real package
    // here: swc gave 0 sources, babel gave 9, all resolving.
    writeFileSync(join(workspaceRoot, 'packages/sdk/rollup.config.cjs'), GENERATED_ROLLUP_CONFIG)

    await runAdd('npm-lib', 'sdk', {})

    const config = readFileSync(join(workspaceRoot, 'packages/sdk/rollup.config.cjs'), 'utf8')
    expect(config).toContain("compiler: 'babel'")
    expect(config).not.toContain("compiler: 'swc'")
  })

  it('repairs the sourcemap source paths, which rollup emits wrong twice over', async () => {
    // rollup hands sourcemapPathTransform an OS-native path with one parent
    // segment too many, so `sources` point at a directory above the project and
    // resolve to nothing. Both are fixed: separators (a sources entry is
    // URL-style, so a backslash is wrong on every platform) and depth.
    writeFileSync(join(workspaceRoot, 'packages/sdk/rollup.config.cjs'), GENERATED_ROLLUP_CONFIG)

    await runAdd('npm-lib', 'sdk', {})

    const config = readFileSync(join(workspaceRoot, 'packages/sdk/rollup.config.cjs'), 'utf8')
    expect(config).toContain('sourcemapPathTransform')
    // A collapse, not a fixed prefix, so it cannot go stale at another depth.
    expect(config).toContain("replace(/^([.][.][/])+/, '../')")
  })

  it('keeps the source maps out of the published tarball', async () => {
    // The counterweight to building them unconditionally: a .js.map carries the
    // whole of sourcesContent, so publishing them would multiply the tarball for
    // a benefit only this workspace's own debugger collects.
    seedGeneratedManifest()

    await runAdd('npm-lib', 'sdk', {})

    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, 'packages/sdk/package.json'), 'utf8')
    ) as { files: string[] }
    expect(manifest.files).toContain('!**/*.js.map')
    // The declaration-map exclusion and the generator's own entries survive.
    expect(manifest.files).toContain('!**/*.d.ts.map')
    expect(manifest.files).toContain('dist')
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

  it('replaces the stock README, which credits Nx rather than mnci', async () => {
    // Nx did not generate this project - mnci did, delegating one step to an Nx
    // generator. Its README also names the project by directory rather than by the
    // package the workspace publishes. (The directory form works; it is just the
    // more ambiguous of two working forms.)
    writeFileSync(
      join(workspaceRoot, 'packages/sdk/README.md'),
      '# sdk\n\nThis library was generated with [Nx](https://nx.dev).\n'
    )

    await runAdd('npm-lib', 'sdk', {})

    const readme = readFileSync(
      join(workspaceRoot, 'packages/sdk/README.md'),
      'utf8'
    )
    expect(readme).toContain('MoNecromanCI')
    expect(readme).not.toContain('generated with [Nx]')
    // Named by the package, which is what nx show projects prints.
    expect(readme).toContain('@demo/sdk')
  })

  it('names the workspace test runner in the README it writes', async () => {
    await runAdd('npm-lib', 'sdk', {})

    const readme = readFileSync(
      join(workspaceRoot, 'packages/sdk/README.md'),
      'utf8'
    )
    expect(readme).toContain('Jest')
  })

  it('removes the .gitkeep from a scaffold directory that now holds a project', async () => {
    // create-nx-workspace drops one into apps/, libs/ and packages/ so git tracks
    // them while empty. Once a project lands there it is not merely redundant, it
    // says "this directory is empty" about a directory that is not.
    mkdirSync(join(workspaceRoot, 'libs'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'packages/.gitkeep'), '')
    writeFileSync(join(workspaceRoot, 'libs/.gitkeep'), '')

    await runAdd('npm-lib', 'sdk', {})

    expect(existsSync(join(workspaceRoot, 'packages/.gitkeep'))).toBe(false)
    // libs/ is still empty, so its marker is still doing its job.
    expect(existsSync(join(workspaceRoot, 'libs/.gitkeep'))).toBe(true)
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
