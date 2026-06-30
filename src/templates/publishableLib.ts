import { readAsset } from '../engine/assets'
import { TAGS } from '../engine/constants'
import { toJson } from '../engine/fsx'
import { registryUrl } from '../engine/registry'
import type { FileSpec, ProjectVars } from '../engine/types'

function publishConfig (vars: ProjectVars): Record<string, string> | undefined {
  const url = vars.registry ? registryUrl(vars.registry) : undefined
  return url ? { registry: url } : undefined
}

function tsconfig (): string {
  return toJson({
    extends:         '../../tsconfig.base.json',
    compilerOptions: {
      baseUrl:                      '.',
      rootDir:                      '.',
      outDir:                       './dist',
      module:                       'nodenext',
      moduleResolution:             'nodenext',
      target:                       'es2024',
      lib:                          ['es2024'],
      noEmit:                       true,
      emitDeclarationOnly:          true,
      sourceMap:                    true,
      declaration:                  true,
      declarationMap:               true,
      removeComments:               false,
      allowSyntheticDefaultImports: true,
      importHelpers:                true,
      isolatedModules:              true,
    },
    exclude: ['./coverage/**', './dist/**', './doc/**', './node_modules/**'],
  })
}

function tsconfigLib (): string {
  return toJson({
    extends:         './tsconfig.json',
    compilerOptions: {
      rootDir:             './src',
      noEmit:              false,
      emitDeclarationOnly: false,
      sourceMap:           true,
      declaration:         true,
      declarationMap:      true,
      removeComments:      false,
    },
    exclude: ['./coverage/**', './dist/**', './doc/**', './node_modules/**', './src/**/*.test.ts'],
  })
}

function typedoc (): string {
  return toJson({
    extends:     ['../../typedoc.json'],
    entryPoints: ['./src'],
    out:         'doc',
    exclude:     ['./node_modules/**', './src/**/*.test.ts'],
  })
}

function projectJson (vars: ProjectVars, buildCommand: string): string {
  const run = (target: string): { executor: string, options: { command: string } } => ({
    executor: 'nx:run-commands',
    options:  { command: `npm run ${target} -w ${vars.packageName}` },
  })

  return toJson({
    name:        vars.name,
    $schema:     '../../node_modules/nx/schemas/project-schema.json',
    sourceRoot:  `libs/${vars.name}/src`,
    projectType: vars.kind === 'cli-tool' ? 'application' : 'library',
    tags:        [TAGS.publishableLib],
    targets:     {
      build: { executor: 'nx:run-commands', outputs: ['{projectRoot}/dist'], options: { command: buildCommand } },
      test:  run('test'),
      lint:  run('lint'),
      doc:   run('doc'),
    },
  })
}

const greeterTs = `/**
 * Returns a friendly greeting for the given name.
 *
 * @remarks The package's public API entry point.
 * @param name - The name to greet (surrounding whitespace is trimmed).
 * @returns The greeting text.
 * @throws Never - performs no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function greet (name: string): string {
  const trimmed = name.trim() // ← breakpoint here works under "Debug Jest (current file)"

  return 'Hello, ' + trimmed + '!'
}
`

const greeterTestTs = `import { greet } from './index'

describe('greet', () => {
  it('greets a trimmed name', () => {
    expect(greet('  Ada  ')).toBe('Hello, Ada!')
  })
})
`

/** The vendored resolved-deps script, written once at the repo root tools/ dir. */
function distPackageScript (): FileSpec {
  return {
    path:      'tools/generate-dist-package.mjs',
    content:   readAsset('scripts/generate-dist-package.mjs'),
    ownership: 'tool-owned',
  }
}

/**
 * Files for a publishable library at `libs/<name>` (published to Azure Artifacts).
 *
 * @remarks
 * Generates both `tool-owned` config and `scaffold` source files.
 *
 * @param vars - The project's template inputs.
 * @returns The full set of file specs for the publishable library.
 * @throws Never - performs no I/O; callers (e.g. {@link applyFiles}) handle writes.
 * @typeParam None - this function has no generic type parameters.
 */
export function publishableLibFiles (vars: ProjectVars): FileSpec[] {
  const root = `libs/${vars.name}`
  const buildCommand = `npm run build -w ${vars.packageName}`
  const packageJson = toJson({
    name:          vars.packageName,
    version:       '0.0.0',
    type:          'commonjs',
    main:          './src/index.ts',
    types:         './src/index.ts',
    publishConfig: publishConfig(vars),
    monecromanci:  { dist: { main: './index.js', types: './index.d.ts' } },
    dependencies:  {},
    scripts:       {
      build:   'tsc -p ./tsconfig.lib.json && node ../../tools/generate-dist-package.mjs',
      test:    'jest --collectCoverage',
      lint:    'eslint . -c ../../eslint.config.mjs',
      doc:     'typedoc --tsconfig tsconfig.lib.json',
      publish: 'npm publish ./dist',
    },
  })

  const file = (path: string, content: string, ownership: FileSpec['ownership']): FileSpec => ({ path: `${root}/${path}`, content, ownership })

  return [
    file('package.json', packageJson, 'scaffold'),
    file('project.json', projectJson(vars, buildCommand), 'tool-owned'),
    file('tsconfig.json', tsconfig(), 'tool-owned'),
    file('tsconfig.lib.json', tsconfigLib(), 'tool-owned'),
    file('jest.config.mjs', `import { createConfig } from '../../jest.preset.mjs'\n\nexport default createConfig('${vars.name}')\n`, 'scaffold'),
    file('typedoc.json', typedoc(), 'tool-owned'),
    file('src/index.ts', 'export * from \'./greeter\'\n', 'scaffold'),
    file('src/greeter.ts', greeterTs, 'scaffold'),
    file('src/greeter.test.ts', greeterTestTs, 'scaffold'),
    distPackageScript(),
  ]
}

const cliMainTs = String.raw`/** Sample CLI entry point. Replace with your own command logic. */
function main (argv: string[]): void {
  const name = argv[0] ?? 'world'
  process.stdout.write('Hello, ' + name + '!\n')
}

main(process.argv.slice(2))
`

const cliMainTestTs = `import { greet } from './greeter'

describe('greet', () => {
  it('greets a name', () => {
    expect(greet('world')).toBe('Hello, world!')
  })
})
`

const cliGreeterTs = `/**
 * Returns the greeting printed by the CLI.
 *
 * @remarks Replace with your own command logic.
 * @param name - The name to greet.
 * @returns The greeting text.
 * @throws Never - performs no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function greet (name: string): string {
  return 'Hello, ' + name + '!'
}
`

/**
 * Files for an executable CLI tool (a publishable lib that also ships a bin).
 *
 * @remarks
 * Generates both `tool-owned` config and `scaffold` source files.
 *
 * @param vars - The project's template inputs.
 * @returns The full set of file specs for the CLI tool.
 * @throws Never - performs no I/O; callers (e.g. {@link applyFiles}) handle writes.
 * @typeParam None - this function has no generic type parameters.
 */
export function cliToolFiles (vars: ProjectVars): FileSpec[] {
  const root = `libs/${vars.name}`
  const buildCommand = `npm run build -w ${vars.packageName}`
  const esbuild = 'esbuild src/cli.ts --bundle --platform=node --target=node24 --outfile=dist/cli.js'
  const packageJson = toJson({
    name:          vars.packageName,
    version:       '0.0.0',
    type:          'commonjs',
    main:          './src/cli.ts',
    bin:           { [vars.name]: './dist/cli.js' },
    publishConfig: publishConfig(vars),
    monecromanci:  { dist: { main: './cli.js', bin: { [vars.name]: './cli.js' } } },
    dependencies:  {},
    scripts:       {
      build:   `${esbuild} && node ../../tools/generate-dist-package.mjs`,
      test:    'jest --collectCoverage',
      lint:    'eslint . -c ../../eslint.config.mjs',
      doc:     'typedoc --tsconfig tsconfig.lib.json',
      publish: 'npm publish ./dist',
    },
  })

  const file = (path: string, content: string, ownership: FileSpec['ownership']): FileSpec => ({ path: `${root}/${path}`, content, ownership })

  return [
    file('package.json', packageJson, 'scaffold'),
    file('project.json', projectJson(vars, buildCommand), 'tool-owned'),
    file('tsconfig.json', tsconfig(), 'tool-owned'),
    file('tsconfig.lib.json', tsconfigLib(), 'tool-owned'),
    file('jest.config.mjs', `import { createConfig } from '../../jest.preset.mjs'\n\nexport default createConfig('${vars.name}')\n`, 'scaffold'),
    file('typedoc.json', typedoc(), 'tool-owned'),
    file('src/cli.ts', cliMainTs, 'scaffold'),
    file('src/greeter.ts', cliGreeterTs, 'scaffold'),
    file('src/greeter.test.ts', cliMainTestTs, 'scaffold'),
    distPackageScript(),
  ]
}
