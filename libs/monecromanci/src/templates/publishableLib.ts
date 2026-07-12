import { TAGS } from '../engine/constants'
import { toJson } from '../engine/fsx'
import { registryUrl } from '../engine/registry'
import type { FileSpec, ProjectVars } from '../engine/types'

/** Builds an `nx:run-commands` target that runs `command` from the project's own directory. */
function runInProject (command: string): { executor: string, options: { command: string, cwd: string } } {
  return { executor: 'nx:run-commands', options: { command, cwd: '{projectRoot}' } }
}

/** Builds the package.json publishConfig for the configured registry, if any. */
function publishConfig (vars: ProjectVars): Record<string, string> | undefined {
  const url = vars.registry ? registryUrl(vars.registry) : undefined
  return url ? { registry: url } : undefined
}

/** Builds the project tsconfig extending the shared base. */
function tsconfig (): string {
  return toJson({
    extends:         'monecromanci-toolchain/tsconfig.base.json',
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

/** Builds the emit tsconfig used by the build target. */
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

/** Builds the typedoc.json extending the repo-level config. */
function typedoc (): string {
  return toJson({
    extends:     ['monecromanci-toolchain/typedoc.json'],
    entryPoints: ['./src'],
    out:         'doc',
    exclude:     ['./node_modules/**', './src/**/*.test.ts'],
  })
}

/** Builds the NX project.json with build/test/lint/doc targets. */
function projectJson (vars: ProjectVars, buildCommand: string): string {
  return toJson({
    name:        vars.name,
    $schema:     '../../node_modules/nx/schemas/project-schema.json',
    sourceRoot:  `libs/${vars.name}/src`,
    projectType: vars.kind === 'cli-tool' ? 'application' : 'library',
    tags:        [TAGS.publishableLib, ...(vars.extraTags ?? [])],
    targets:     {
      build: { executor: 'nx:run-commands', outputs: ['{projectRoot}/dist'], options: { command: buildCommand, cwd: '{projectRoot}' } },
      test:  runInProject('jest --collectCoverage'),
      lint:  runInProject('eslint . -c ../../eslint.config.mjs'),
      doc:   runInProject('typedoc --tsconfig tsconfig.lib.json'),
    },
  })
}

/** Stable delegators: real commands live in project.json's targets (tool-owned, always kept in sync), never here (scaffold-owned, never revisited once created). */
function delegatorScripts (vars: ProjectVars): Record<string, string> {
  return {
    build: `nx run ${vars.name}:build`,
    test:  `nx run ${vars.name}:test`,
    lint:  `nx run ${vars.name}:lint`,
    doc:   `nx run ${vars.name}:doc`,
  }
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
  const buildCommand = 'tsc -p ./tsconfig.lib.json && node ../../node_modules/monecromanci-toolchain/scripts/generate-dist-package.mjs'
  const packageJson = toJson({
    name:          vars.packageName,
    version:       '0.0.0',
    type:          'commonjs',
    main:          './src/index.ts',
    types:         './src/index.ts',
    publishConfig: publishConfig(vars),
    monecromanci:  { dist: { main: './index.js', types: './index.d.ts' } },
    dependencies:  {},
    scripts:       delegatorScripts(vars),
  })

  const file = (path: string, content: string, ownership: FileSpec['ownership']): FileSpec => ({ path: `${root}/${path}`, content, ownership })

  return [
    file('package.json', packageJson, 'scaffold'),
    file('project.json', projectJson(vars, buildCommand), 'tool-owned'),
    file('tsconfig.json', tsconfig(), 'tool-owned'),
    file('tsconfig.lib.json', tsconfigLib(), 'tool-owned'),
    file('jest.config.mjs', `import { createConfig } from 'monecromanci-toolchain/jest.preset.mjs'\n\nexport default createConfig('${vars.name}')\n`, 'tool-owned'),
    file('typedoc.json', typedoc(), 'tool-owned'),
    file('src/index.ts', 'export * from \'./greeter\'\n', 'scaffold'),
    file('src/greeter.ts', greeterTs, 'scaffold'),
    file('src/greeter.test.ts', greeterTestTs, 'scaffold'),
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
  const esbuild = 'esbuild src/cli.ts --bundle --platform=node --target=node24 --outfile=dist/cli.js'
  const buildCommand = `${esbuild} && node ../../node_modules/monecromanci-toolchain/scripts/generate-dist-package.mjs`
  const packageJson = toJson({
    name:          vars.packageName,
    version:       '0.0.0',
    type:          'commonjs',
    main:          './src/cli.ts',
    bin:           { [vars.name]: './dist/cli.js' },
    publishConfig: publishConfig(vars),
    monecromanci:  { dist: { main: './cli.js', bin: { [vars.name]: './cli.js' } } },
    dependencies:  {},
    scripts:       delegatorScripts(vars),
  })

  const file = (path: string, content: string, ownership: FileSpec['ownership']): FileSpec => ({ path: `${root}/${path}`, content, ownership })

  return [
    file('package.json', packageJson, 'scaffold'),
    file('project.json', projectJson(vars, buildCommand), 'tool-owned'),
    file('tsconfig.json', tsconfig(), 'tool-owned'),
    file('tsconfig.lib.json', tsconfigLib(), 'tool-owned'),
    file('jest.config.mjs', `import { createConfig } from 'monecromanci-toolchain/jest.preset.mjs'\n\nexport default createConfig('${vars.name}')\n`, 'tool-owned'),
    file('typedoc.json', typedoc(), 'tool-owned'),
    file('src/cli.ts', cliMainTs, 'scaffold'),
    file('src/greeter.ts', cliGreeterTs, 'scaffold'),
    file('src/greeter.test.ts', cliMainTestTs, 'scaffold'),
  ]
}
