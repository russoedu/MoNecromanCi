import { TAGS } from '../engine/constants'
import { toJson } from '../engine/fsx'
import type { FileSpec, ProjectVars } from '../engine/types'

/** Builds an `nx:run-commands` target that runs `command` from the project's own directory. */
function runInProject (command: string): { executor: string, options: { command: string, cwd: string } } {
  return { executor: 'nx:run-commands', options: { command, cwd: '{projectRoot}' } }
}

/** Builds the app's package.json (scripts run the shared root toolchain). */
function appPackageJson (vars: ProjectVars): string {
  return toJson({
    name:         vars.packageName,
    version:      '0.0.0',
    private:      true,
    type:         'commonjs',
    main:         'dist/index.js',
    dependencies: {},
    // build/serve/test/lint/doc are stable delegators: the real commands live
    // in project.json's targets (tool-owned, always kept in sync) rather than
    // here (scaffold-owned, never revisited once created). watch/dev are
    // local-only dev convenience scripts with no corresponding nx target.
    scripts:      {
      build: `nx run ${vars.name}:build`,
      watch: 'tsc -p tsconfig.app.json -w',
      start: `nx run ${vars.name}:serve`,
      dev:   'tsx watch src/index.ts',
      lint:  `nx run ${vars.name}:lint`,
      test:  `nx run ${vars.name}:test`,
      doc:   `nx run ${vars.name}:doc`,
    },
  })
}

/** Builds the NX project.json with build/serve/test/lint/doc targets. */
function appProjectJson (vars: ProjectVars): string {
  return toJson({
    name:        vars.name,
    $schema:     '../../node_modules/nx/schemas/project-schema.json',
    sourceRoot:  `apps/${vars.name}/src`,
    projectType: 'application',
    tags:        [TAGS.nodeApp, ...(vars.extraTags ?? [])],
    targets:     {
      build: { executor: 'nx:run-commands', outputs: ['{projectRoot}/dist'], options: { command: 'tsc -p tsconfig.app.json', cwd: '{projectRoot}' } },
      serve: runInProject('node dist/index.js'),
      test:  runInProject('jest --collectCoverage'),
      lint:  runInProject('eslint . -c ../../eslint.config.mjs'),
      doc:   runInProject('typedoc --tsconfig tsconfig.app.json'),
    },
  })
}

/** Builds the project tsconfig extending the shared base. */
function appTsconfig (): string {
  return toJson({
    extends:         'monecromanci-toolchain/tsconfig.base.json',
    compilerOptions: {
      baseUrl:          '.',
      rootDir:          '.',
      outDir:           './dist',
      module:           'commonjs',
      moduleResolution: 'node',
      target:           'es2022',
      sourceMap:        true,
      declaration:      false,
      declarationMap:   false,
      esModuleInterop:  true,
    },
    exclude: ['./coverage/**', './dist/**', './doc/**', './node_modules/**'],
  })
}

/** Builds the emit tsconfig used by the build target. */
function appTsconfigApp (): string {
  return toJson({
    extends:         './tsconfig.json',
    compilerOptions: {
      rootDir:        './src',
      noEmit:         false,
      sourceMap:      true,
      removeComments: false,
    },
    exclude: ['./coverage/**', './dist/**', './doc/**', './node_modules/**', './src/**/*.test.ts'],
  })
}

/** Builds the typedoc.json extending the repo-level config. */
function appTypedoc (): string {
  return toJson({
    extends:     ['monecromanci-toolchain/typedoc.json'],
    entryPoints: ['./src'],
    out:         'doc',
    exclude:     ['./node_modules/**', './src/**/*.test.ts'],
  })
}

const serverTs = `import { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Builds the greeting returned by the server.
 *
 * @remarks Pure string helper — replace with your own logic.
 * @param name - The name to greet.
 * @returns The greeting text.
 * @throws Never - performs no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function buildGreeting (name: string): string {
  return 'Hello, ' + name + '!'
}

/**
 * Handles an HTTP request, replying with a plain-text greeting.
 *
 * @remarks Swap in Express, Koa, Fastify, Nest or any framework you prefer.
 * @param request - The incoming HTTP request.
 * @param response - The HTTP response to write to.
 * @returns Nothing.
 * @throws Never - failures surface through the Node HTTP server.
 * @typeParam None - this function has no generic type parameters.
 */
export function handleRequest (request: IncomingMessage, response: ServerResponse): void {
  const requestUrl = new URL(request.url ?? '/', 'http://localhost')
  const name = requestUrl.searchParams.get('name') ?? 'world'

  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end(buildGreeting(name))
}
`

const indexTs = `import { createServer } from 'node:http'
import { handleRequest } from './server'

const port = Number(process.env.PORT ?? 3000)

createServer(handleRequest).listen(port, () => {
  console.log('Server listening on http://localhost:' + port)
})
`

const serverTestTs = `import { buildGreeting } from './server'

describe('buildGreeting', () => {
  it('greets a name', () => {
    expect(buildGreeting('world')).toBe('Hello, world!')
  })
})
`

/**
 * Files for a generic Node.js app at `apps/<name>`.
 *
 * @remarks
 * A framework-agnostic TS HTTP server (node:http) the user extends with any
 * framework. Generates both `tool-owned` config and `scaffold` source files.
 *
 * @param vars - The project's template inputs.
 * @returns The full set of file specs for the Node app.
 * @throws Never - performs no I/O; callers (e.g. {@link applyFiles}) handle writes.
 * @typeParam None - this function has no generic type parameters.
 */
export function nodeAppFiles (vars: ProjectVars): FileSpec[] {
  const root = `apps/${vars.name}`
  const file = (path: string, content: string, ownership: FileSpec['ownership']): FileSpec => ({ path: `${root}/${path}`, content, ownership })

  return [
    file('package.json', appPackageJson(vars), 'scaffold'),
    file('project.json', appProjectJson(vars), 'tool-owned'),
    file('tsconfig.json', appTsconfig(), 'tool-owned'),
    file('tsconfig.app.json', appTsconfigApp(), 'tool-owned'),
    file('jest.config.mjs', `import { createConfig } from 'monecromanci-toolchain/jest.preset.mjs'\n\nexport default createConfig('${vars.name}')\n`, 'tool-owned'),
    file('typedoc.json', appTypedoc(), 'tool-owned'),
    file('src/index.ts', indexTs, 'scaffold'),
    file('src/server.ts', serverTs, 'scaffold'),
    file('src/server.test.ts', serverTestTs, 'scaffold'),
  ]
}
