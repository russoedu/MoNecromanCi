import { readAsset } from '../engine/assets'
import { TAGS } from '../engine/constants'
import { toJson } from '../engine/fsx'
import type { FileSpec, ProjectVars } from '../engine/types'

function appPackageJson (vars: ProjectVars): string {
  return toJson({
    name:         vars.packageName,
    version:      '0.0.0',
    private:      true,
    type:         'commonjs',
    main:         'dist/index.js',
    dependencies: {},
    scripts:      {
      build:          'tsc -p tsconfig.app.json',
      watch:          'tsc -p tsconfig.app.json -w',
      start:          'func start',
      'clean:config': 'node ../../tools/clean-config.mjs',
      lint:           'eslint . -c ../../eslint.config.mjs',
      test:           'jest --collectCoverage',
      doc:            'typedoc --tsconfig tsconfig.app.json',
    },
  })
}

function appProjectJson (vars: ProjectVars): string {
  const run = (target: string): { executor: string, options: { command: string } } => ({
    executor: 'nx:run-commands',
    options:  { command: `npm run ${target} -w ${vars.packageName}` },
  })

  return toJson({
    name:        vars.name,
    $schema:     '../../node_modules/nx/schemas/project-schema.json',
    sourceRoot:  `apps/${vars.name}/src`,
    projectType: 'application',
    tags:        [TAGS.functionApp],
    targets:     {
      build: { executor: 'nx:run-commands', outputs: ['{projectRoot}/dist'], options: { command: `npm run build -w ${vars.packageName}` } },
      serve: run('start'),
      test:  run('test'),
      lint:  run('lint'),
      doc:   run('doc'),
    },
  })
}

function appTsconfig (): string {
  return toJson({
    extends:         '../../tsconfig.base.json',
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

function appTypedoc (): string {
  return toJson({
    extends:     ['../../typedoc.json'],
    entryPoints: ['./src'],
    out:         'doc',
    exclude:     ['./node_modules/**', './src/**/*.test.ts'],
  })
}

function hostJson (): string {
  return toJson({
    version: '2.0',
    logging: {
      applicationInsights: {
        samplingSettings: { isEnabled: true, excludedTypes: 'Request' },
      },
    },
    extensionBundle: {
      id:      'Microsoft.Azure.Functions.ExtensionBundle',
      version: '[4.*, 5.0.0)',
    },
  })
}

function localSettingsJson (): string {
  // Gitignored. The --inspect arg lets VSCode attach on :9229 for TS debugging.
  return toJson({
    IsEncrypted: false,
    Values:      {
      FUNCTIONS_WORKER_RUNTIME:         'node',
      AzureWebJobsStorage:              '',
      languageWorkers__node__arguments: '--inspect=9229',
    },
  })
}

function configurationFile (environment: string): string {
  return toJson([
    { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node', slotSetting: false },
    { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~24', slotSetting: false },
    { name: 'ENVIRONMENT', value: environment, slotSetting: false },
  ])
}

const greetingTs = `/** Builds the greeting returned by the sample HTTP function. */
export function buildGreeting (name: string): string {
  return 'Hello, ' + name + '!'
}
`

const greetingTestTs = `import { buildGreeting } from './greeting'

describe('buildGreeting', () => {
  it('greets a name', () => {
    expect(buildGreeting('world')).toBe('Hello, world!')
  })
})
`

const helloTs = `import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { buildGreeting } from '../greeting'

export async function hello (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('HTTP function processed a request for ' + request.url)
  const name = request.query.get('name') ?? 'world'

  return { body: buildGreeting(name) }
}

app.http('hello', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: hello,
})
`

const indexTs = `import './functions/hello'
`

/** Files for an Azure Function App at `apps/<name>`. */
export function functionAppFiles (vars: ProjectVars): FileSpec[] {
  const root = `apps/${vars.name}`
  const file = (path: string, content: string, ownership: FileSpec['ownership']): FileSpec => ({ path: `${root}/${path}`, content, ownership })

  return [
    file('package.json', appPackageJson(vars), 'scaffold'),
    file('project.json', appProjectJson(vars), 'tool-owned'),
    file('tsconfig.json', appTsconfig(), 'tool-owned'),
    file('tsconfig.app.json', appTsconfigApp(), 'tool-owned'),
    file('host.json', hostJson(), 'scaffold'),
    file('local.settings.json', localSettingsJson(), 'scaffold'),
    file('jest.config.mjs', `import { createConfig } from '../../jest.preset.mjs'\n\nexport default createConfig('${vars.name}')\n`, 'scaffold'),
    file('typedoc.json', appTypedoc(), 'tool-owned'),
    file('.configurations/dev.json', configurationFile('dev'), 'scaffold'),
    file('.configurations/uat.json', configurationFile('uat'), 'scaffold'),
    file('.configurations/prod.json', configurationFile('prod'), 'scaffold'),
    file('src/index.ts', indexTs, 'scaffold'),
    file('src/greeting.ts', greetingTs, 'scaffold'),
    file('src/greeting.test.ts', greetingTestTs, 'scaffold'),
    file('src/functions/hello.ts', helloTs, 'scaffold'),
    { path: 'tools/clean-config.mjs', content: readAsset('scripts/clean-config.mjs'), ownership: 'tool-owned' },
  ]
}
