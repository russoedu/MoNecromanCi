import { TAGS } from '../engine/constants'
import { toJson } from '../engine/fsx'
import type { FileSpec, ProjectVars } from '../engine/types'

function libPackageJson (vars: ProjectVars): string {
  return toJson({
    name: vars.packageName,
    version: '0.0.0',
    private: true,
    type: 'commonjs',
    // Point at source so consumers resolve TS directly: enables step-into-source
    // debugging and editor "find references" across internal libraries.
    main: './src/index.ts',
    types: './src/index.ts',
    dependencies: {},
    scripts: {
      build: 'tsc -p ./tsconfig.lib.json',
      test: 'jest --collectCoverage',
      lint: 'eslint . -c ../../eslint.config.mjs',
      doc: 'typedoc --tsconfig tsconfig.lib.json',
    },
  })
}

function libProjectJson (vars: ProjectVars): string {
  const run = (target: string): { executor: string, options: { command: string } } => ({
    executor: 'nx:run-commands',
    options: { command: `npm run ${target} -w ${vars.packageName}` },
  })

  return toJson({
    name: vars.name,
    $schema: '../../node_modules/nx/schemas/project-schema.json',
    sourceRoot: `libs/${vars.name}/src`,
    projectType: 'library',
    tags: [TAGS.internalLib],
    targets: {
      build: { executor: 'nx:run-commands', outputs: ['{projectRoot}/dist'], options: { command: `npm run build -w ${vars.packageName}` } },
      test: run('test'),
      lint: run('lint'),
      doc: run('doc'),
    },
  })
}

function libTsconfig (): string {
  return toJson({
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      baseUrl: '.',
      rootDir: '.',
      outDir: './dist',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      target: 'es2024',
      lib: ['es2024'],
      noEmit: true,
      emitDeclarationOnly: true,
      sourceMap: true,
      declaration: true,
      declarationMap: true,
      removeComments: false,
      allowSyntheticDefaultImports: true,
      importHelpers: true,
      isolatedModules: true,
    },
    exclude: ['./coverage/**', './dist/**', './doc/**', './node_modules/**'],
  })
}

function libTsconfigLib (): string {
  return toJson({
    extends: './tsconfig.json',
    compilerOptions: {
      rootDir: './src',
      noEmit: false,
      emitDeclarationOnly: false,
      sourceMap: true,
      declaration: true,
      declarationMap: true,
      removeComments: false,
    },
    exclude: ['./coverage/**', './dist/**', './doc/**', './node_modules/**', './src/**/*.test.ts', './src/_jest/**'],
  })
}

function libTypedoc (): string {
  return toJson({
    extends: ['../../typedoc.json'],
    entryPoints: ['./src'],
    out: 'doc',
    exclude: ['./node_modules/**', './src/**/*.test.ts'],
  })
}

const indexTs = `export * from './greeter'
`

const greeterTs = `/** Returns a friendly greeting for the given name. */
export function greet (name: string): string {
  const trimmed = name.trim() // ← set a breakpoint here, then run "Debug Jest (current file)"

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

/** Returns every file for a new internal library at `libs/<name>`. */
export function internalLibFiles (vars: ProjectVars): FileSpec[] {
  const root = `libs/${vars.name}`
  const toolOwned = (path: string, content: string): FileSpec => ({ path: `${root}/${path}`, content, ownership: 'tool-owned' })
  const scaffold = (path: string, content: string): FileSpec => ({ path: `${root}/${path}`, content, ownership: 'scaffold' })

  return [
    scaffold('package.json', libPackageJson(vars)),
    toolOwned('project.json', libProjectJson(vars)),
    toolOwned('tsconfig.json', libTsconfig()),
    toolOwned('tsconfig.lib.json', libTsconfigLib()),
    scaffold('jest.config.mjs', `import { createConfig } from '../../jest.preset.mjs'\n\nexport default createConfig('${vars.name}')\n`),
    toolOwned('typedoc.json', libTypedoc()),
    scaffold('src/index.ts', indexTs),
    scaffold('src/greeter.ts', greeterTs),
    scaffold('src/greeter.test.ts', greeterTestTs),
  ]
}
