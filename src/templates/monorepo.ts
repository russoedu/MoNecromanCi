import { listAssetFiles, readAsset } from '../engine/assets'
import { toJson } from '../engine/fsx'
import type { FileSpec, MonorepoVars } from '../engine/types'
import rootPackageJson from '../../package.json'

const sharedDependency = (name: keyof typeof rootPackageJson.devDependencies): string => rootPackageJson.devDependencies[name]

/**
 * Pinned toolchain for generated monorepos (mirrors the proven JATO set).
 *
 * Shared entries (ESLint/TS/Jest toolchain) reuse the exact versions nx-magic
 * itself depends on, sourced from this package's own `devDependencies`, so the
 * two never drift apart. Generated-repo-only packages (nx, esbuild, husky, the
 * commitlint/typedoc tooling) are pinned here directly since nx-magic has no
 * use for them itself.
 */
const DEV_DEPENDENCIES: Record<string, string> = {
  '@commitlint/cli':                 '^21.1.0',
  '@commitlint/config-conventional': '^21.1.0',
  '@eslint/markdown':                sharedDependency('@eslint/markdown'),
  '@stylistic/eslint-plugin':        sharedDependency('@stylistic/eslint-plugin'),
  '@types/jest':                     sharedDependency('@types/jest'),
  '@types/node':                     sharedDependency('@types/node'),
  esbuild:                           '^0.28.1',
  eslint:                            sharedDependency('eslint'),
  'eslint-plugin-jest':              sharedDependency('eslint-plugin-jest'),
  'eslint-plugin-jsonc':             sharedDependency('eslint-plugin-jsonc'),
  'eslint-plugin-n':                 sharedDependency('eslint-plugin-n'),
  'eslint-plugin-promise':           sharedDependency('eslint-plugin-promise'),
  'eslint-plugin-react':             sharedDependency('eslint-plugin-react'),
  'eslint-plugin-react-hooks':       sharedDependency('eslint-plugin-react-hooks'),
  'eslint-plugin-react-refresh':     sharedDependency('eslint-plugin-react-refresh'),
  'eslint-plugin-tsdoc':             sharedDependency('eslint-plugin-tsdoc'),
  'eslint-plugin-tsdoc-require-2':   sharedDependency('eslint-plugin-tsdoc-require-2'),
  'eslint-plugin-unicorn':           sharedDependency('eslint-plugin-unicorn'),
  'eslint-plugin-unused-imports':    sharedDependency('eslint-plugin-unused-imports'),
  'eslint-plugin-yml':               sharedDependency('eslint-plugin-yml'),
  globals:                           sharedDependency('globals'),
  husky:                             '^9.1.7',
  jest:                              sharedDependency('jest'),
  'jest-junit':                      '^17.0.0',
  nx:                                '^23.0.1',
  'ts-jest':                         sharedDependency('ts-jest'),
  'tsc-alias':                       '^1.8.17',
  tslib:                             '^2.8.1',
  typedoc:                           '^0.28.19',
  'typedoc-plugin-missing-exports':  '^4.1.3',
  typescript:                        sharedDependency('typescript'),
  'typescript-eslint':               sharedDependency('typescript-eslint'),
}

function packageJson (vars: MonorepoVars): string {
  return toJson({
    name:       vars.workspaceName,
    version:    '0.0.0',
    private:    true,
    license:    'UNLICENSED',
    workspaces: ['apps/*', 'libs/*'],
    scripts:    {
      build:              'nx run-many -t build --all',
      'build:affected':   'nx affected -t build',
      lint:               'nx run-many -t lint --all',
      'lint:affected':    'nx affected -t lint',
      test:               'nx run-many -t test --all',
      'test:affected':    'nx affected -t test',
      doc:                'nx run-many -t doc --all',
      'doc:affected':     'nx affected -t doc',
      affected:           'nx affected -t lint,test,build',
      projects:           'nx show projects',
      graph:              'nx graph',
      'nx:reset':         'nx reset',
      'pipeline:plan':    'node .build-templates/01-preparation.mjs',
      'pipeline:package': 'node .build-templates/03-package-apps.mjs --dry-run',
      release:            'nx release',
      'release:version':  'nx release version',
      'release:publish':  'nx release publish',
      prepare:            'husky',
    },
    dependencies: {
      tslib: '^2.8.1',
    },
    devDependencies: DEV_DEPENDENCIES,
    engines:         {
      node: `>=${vars.nodeVersion}`,
    },
  })
}

function nxJson (vars: MonorepoVars): string {
  return toJson({
    $schema:         './node_modules/nx/schemas/nx-schema.json',
    workspaceLayout: { appsDir: 'apps', libsDir: 'libs' },
    defaultBase:     vars.defaultBase,
    namedInputs:     {
      sharedGlobals: [
        '{workspaceRoot}/package.json',
        '{workspaceRoot}/package-lock.json',
        '{workspaceRoot}/nx.json',
        '{workspaceRoot}/tsconfig.base.json',
        '{workspaceRoot}/jest.preset.mjs',
        '{workspaceRoot}/eslint.config.mjs',
      ],
      default:    ['{projectRoot}/**/*', 'sharedGlobals'],
      production: [
        'default',
        '!{projectRoot}/coverage/**',
        '!{projectRoot}/dist/**',
        '!{projectRoot}/doc/**',
        '!{projectRoot}/**/*.test.ts',
        '!{projectRoot}/src/_jest/**',
      ],
    },
    targetDefaults: {
      build: { dependsOn: ['^build'], inputs: ['production', '^production'], cache: true },
      lint:  { inputs: ['default', '^production'], cache: true },
      test:  { dependsOn: ['build'], inputs: ['default', '^production'], cache: true },
      doc:   { inputs: ['production', '^production'], cache: true },
    },
    release: {
      projectsRelationship: 'independent',
      projects:             ['tag:type:publishable-lib'],
      releaseTagPattern:    '{projectName}@{version}',
      version:              { conventionalCommits: true },
      changelog:            { projectChangelogs: true },
    },
    analytics: false,
  })
}

function tsconfigBase (): string {
  return toJson({
    $schema:         'https://json.schemastore.org/tsconfig',
    compilerOptions: {
      target:                           'es2024',
      types:                            ['jest', 'node'],
      sourceMap:                        true,
      declaration:                      true,
      declarationMap:                   true,
      removeComments:                   false,
      forceConsistentCasingInFileNames: true,
      isolatedModules:                  true,
      noFallthroughCasesInSwitch:       true,
      noUnusedLocals:                   true,
      noUnusedParameters:               true,
      resolveJsonModule:                true,
      skipLibCheck:                     true,
      strict:                           true,
      strictNullChecks:                 true,
      strictPropertyInitialization:     false,
    },
  })
}

function tsconfigJest (): string {
  // sourceMap MUST be true so ts-jest emits maps and VSCode binds breakpoints.
  return toJson({
    extends:         './tsconfig.base.json',
    compilerOptions: {
      target:              'es2022',
      module:              'commonjs',
      moduleResolution:    'node',
      noEmit:              false,
      emitDeclarationOnly: false,
      declaration:         false,
      declarationMap:      false,
      sourceMap:           true,
      esModuleInterop:     true,
    },
  })
}

function typedocJson (): string {
  return toJson({
    $schema:            'https://typedoc.org/schema.json',
    entryPointStrategy: 'expand',
    plugin:             ['typedoc-plugin-missing-exports'],
    excludePrivate:     false,
    categorizeByGroup:  true,
    cleanOutputDir:     true,
  })
}

// Root Jest config: discover every project that ships a jest config, normalising
// Windows backslashes so the paths are valid for Jest's `projects` option.
const jestConfigMjs = String.raw`import { globSync } from 'node:fs'

const projects = globSync('{libs,apps}/*/jest.config.mjs').map((path) => path.replaceAll('\\', '/'))

export default {
  projects: projects.length > 0 ? projects : ['<rootDir>'],
  maxWorkers: '75%',
}
`

// Shared Jest preset factory. Per-project config is one line: createConfig('name').
const jestPresetMjs = String.raw`/** Shared Jest preset — generated by nx-magic. Re-sync with 'nx-magic doctor'. */
export function createConfig (projectName) {
  return {
    displayName:        projectName,
    testEnvironment:    'node',
    rootDir:            '.',
    roots:              ['<rootDir>/src'],
    setupFilesAfterEnv: [
      '<rootDir>/../../jest.setup.mjs',
      '<rootDir>/../../jest.clear.mjs',
    ],
    transform: {
      '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: '<rootDir>/../../tsconfig.jest.json' }],
    },
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json'],
    collectCoverageFrom:  [
      '<rootDir>/src/**/*.ts',
      '!<rootDir>/src/**/*.d.ts',
      '!<rootDir>/src/index.ts',
    ],
    coverageProvider:  'v8',
    coverageDirectory: './coverage',
    coverageReporters: ['text', 'cobertura', 'html', 'lcov'],
    reporters:         [
      'default',
      ['jest-junit', { outputDirectory: './coverage', outputName: 'test-results.xml' }],
    ],
  }
}
`

const jestSetupMjs = `process.env.TZ = 'UTC'

beforeAll(() => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2000-01-01T00:00:00.000Z'))
})

afterAll(() => {
  jest.useRealTimers()
})
`

const jestClearMjs = `afterEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
  jest.resetModules()
})
`

function npmrc (vars: MonorepoVars): string {
  const scopeName = vars.scope.replace(/^@/, '')
  const feedPath = `pkgs.dev.azure.com/${vars.azure.organization}/${vars.azure.project}/_packaging/${vars.azure.artifactsFeed}/npm/registry/`

  return [
    'registry=https://registry.npmjs.org/',
    `@${scopeName}:registry=https://${feedPath}`,
    // Single-quoted to keep ${NODE_AUTH_TOKEN} literal in the generated file.
    `//${feedPath}:_authToken=\${NODE_AUTH_TOKEN}`,
    '',
  ].join('\n')
}

const editorconfig = `root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
`

const gitignore = `node_modules/
dist/
dist-dev/
dist-uat/
dist-prod/
coverage/
doc/
.nx/
tmp/
.azurite/
.pipeline-out/
.pipeline-staging/
*.log
.DS_Store
local.settings.json
`

const commitlintConfigMjs = `export default {
  extends: ['@commitlint/config-conventional'],
}
`

const huskyCommitMessage = `npx --no -- commitlint --edit "$1"
`

function readme (vars: MonorepoVars): string {
  return `# ${vars.displayName}

NX monorepo generated by [nx-magic](https://github.com/russoedu/nx-magic).

## Common commands

\`\`\`sh
npm run build          # build all projects
npm run test           # run all tests
npm run lint           # lint everything
npm run affected       # lint + test + build only what changed
npm run graph          # open the project graph
\`\`\`

## Debugging

Open \`${vars.displayName}.code-workspace\` in VSCode. Use the **Run and Debug** panel:
breakpoints work in \`.ts\` test files (and step into internal libs). The
\`Orta.vscode-jest\` extension also adds a **Debug** lens above each test.

## Adding projects

\`\`\`sh
npx nx-magic add        # interactive: function-app | react-app | internal-lib | publishable-lib | cli-tool
\`\`\`
`
}

function nxReleaseDocument (vars: MonorepoVars): string {
  return `# Releasing publishable libraries & CLI tools

This monorepo uses **\`nx release\`** with **independent** versioning driven by
**Conventional Commits**. Only projects tagged \`type:publishable-lib\` (libraries
and CLI tools) are released; internal libs and apps are never published.

## How versions are decided (auto-bump)

You do **not** hand-edit \`version\` in any \`package.json\`. \`nx release\` reads the
Conventional Commit messages since each project's last release tag and bumps:

| Commit type            | Bump   |
| ---------------------- | ------ |
| \`fix: …\`               | patch  |
| \`feat: …\`              | minor  |
| \`feat!: …\` / \`BREAKING CHANGE\` | major |

Commit messages are enforced by commitlint (\`commitlint.config.mjs\`) via a husky
\`commit-msg\` hook, so the history stays releasable. Scope a commit to a project
with \`fix(my-lib): …\`.

## Local commands

\`\`\`sh
npm run release            # interactive: version + changelog + (optional) publish
npm run release:version    # bump versions + write changelogs from commits
npm run release:publish    # publish what changed to Azure Artifacts
npx nx release --dry-run   # preview everything, change nothing
\`\`\`

## What gets published

\`build\` emits \`dist/\` and runs \`tools/generate-dist-package.mjs\`, which writes a
correct \`dist/package.json\`: it resolves real dependency versions from the **root**
package.json (all deps live there) and from internal workspace packages. This is
why published packages declare their dependencies even though project
\`package.json\` files keep \`dependencies: {}\`. Publishing runs \`npm publish ./dist\`.

## First release

For a project that has never been released, set its starting version once:

\`\`\`sh
npx nx release version 1.0.0 --projects=my-lib --first-release
\`\`\`

## CI

On \`${vars.defaultBase}\` (non-PR builds), the pipeline runs \`nx release version --yes\`
then publishes affected publishable projects to the Azure Artifacts feed
(\`${vars.azure.artifactsFeed}\`). See the pipeline step \`04-publish-libs\`.
`
}

function codeWorkspace (vars: MonorepoVars): string {
  return toJson({
    folders:  [{ path: '.', name: vars.displayName }],
    settings: {
      'eslint.useFlatConfig': true,
      'eslint.validate':      ['javascript', 'typescript', 'typescriptreact', 'json', 'jsonc', 'json5', 'yaml', 'markdown'],
      'files.exclude':        {
        '**/.nx':          true,
        '**/node_modules': true,
        '**/coverage':     true,
        '**/.azurite':     true,
        tmp:               true,
      },
      'typescript.tsdk': 'node_modules/typescript/lib',
      'jest.runMode':    'on-demand',
    },
    extensions: {
      recommendations: [
        'dbaeumer.vscode-eslint',
        'orta.vscode-jest',
        'ms-azuretools.vscode-azurefunctions',
        'ms-edgedevtools.vscode-edge-devtools',
      ],
    },
    // NOTE: launch/tasks are TOP-LEVEL workspace keys (NOT under settings) so VSCode surfaces them.
    launch: {
      version:        '0.2.0',
      configurations: [
        // --- breakpoint-capable debug configs ---
        {
          name:                      'Debug Jest (current file)',
          type:                      'node',
          request:                   'launch',
          program:                   '${workspaceFolder}/node_modules/jest/bin/jest.js',
          args:                      ['--runInBand', '--watchAll=false', '--runTestsByPath', '${relativeFile}'],
          cwd:                       '${workspaceFolder}',
          console:                   'integratedTerminal',
          internalConsoleOptions:    'neverOpen',
          disableOptimisticBPs:      true,
          resolveSourceMapLocations: null,
          sourceMaps:                true,
        },
        {
          name:                      'Debug Jest (all)',
          type:                      'node',
          request:                   'launch',
          program:                   '${workspaceFolder}/node_modules/jest/bin/jest.js',
          args:                      ['--runInBand', '--watchAll=false'],
          cwd:                       '${workspaceFolder}',
          console:                   'integratedTerminal',
          internalConsoleOptions:    'neverOpen',
          disableOptimisticBPs:      true,
          resolveSourceMapLocations: null,
          sourceMaps:                true,
        },
        {
          // Start the host first (in the app dir: `npm run start -w <app>`), then attach.
          name:                      'Debug Function App (attach :9229)',
          type:                      'node',
          request:                   'attach',
          port:                      9229,
          restart:                   true,
          sourceMaps:                true,
          resolveSourceMapLocations: null,
          outFiles:                  ['${workspaceFolder}/apps/*/dist/**/*.js'],
          skipFiles:                 ['<node_internals>/**'],
        },
        {
          // Start the dev server first (`npm run dev -w <app>`), then launch the browser.
          // Or use the JavaScript Debug Terminal: run `npm run dev -w <app>` there.
          name:                      'Debug React (Edge)',
          type:                      'msedge',
          request:                   'launch',
          url:                       'http://localhost:5173',
          webRoot:                   '${workspaceFolder}',
          sourceMaps:                true,
          resolveSourceMapLocations: null,
        },
        // --- convenience run configs (no breakpoints; quick npm scripts) ---
        { name: 'Run: build (all)', type: 'node-terminal', request: 'launch', command: 'npm run build' },
        { name: 'Run: build (affected)', type: 'node-terminal', request: 'launch', command: 'npm run build:affected' },
        { name: 'Run: test (all)', type: 'node-terminal', request: 'launch', command: 'npm run test' },
        { name: 'Run: lint (all)', type: 'node-terminal', request: 'launch', command: 'npm run lint' },
        { name: 'Run: docs (all)', type: 'node-terminal', request: 'launch', command: 'npm run doc' },
        { name: 'Run: graph', type: 'node-terminal', request: 'launch', command: 'npm run graph' },
      ],
    },
    tasks: {
      version: '2.0.0',
      tasks:   [
        { label: 'build all', type: 'shell', command: 'npm run build', problemMatcher: ['$tsc'] },
        { label: 'test all', type: 'shell', command: 'npm run test', problemMatcher: [] },
        { label: 'lint all', type: 'shell', command: 'npm run lint', problemMatcher: [] },
      ],
    },
  })
}

/** Vendored Azure pipeline: azure-pipelines.yml + the .build-templates scripts. */
function pipelineFiles (): FileSpec[] {
  const files: FileSpec[] = [
    { path: 'azure-pipelines.yml', content: readAsset('azure-pipelines.yml'), ownership: 'tool-owned' },
  ]

  for (const relativePath of listAssetFiles('build-templates')) {
    files.push({
      path:      `.build-templates/${relativePath}`,
      content:   readAsset(`build-templates/${relativePath}`),
      ownership: 'tool-owned',
    })
  }

  return files
}

/**
 * Returns every root-level file for a fresh monorepo.
 *
 * @remarks
 * Generates both `tool-owned` config and `scaffold` source files.
 *
 * @param vars - The monorepo's template inputs.
 * @returns The full set of file specs for the monorepo root.
 * @throws Never - performs no I/O; callers (e.g. {@link applyFiles}) handle writes.
 * @typeParam None - this function has no generic type parameters.
 */
export function monorepoFiles (vars: MonorepoVars): FileSpec[] {
  const toolOwned = (path: string, content: string): FileSpec => ({ path, content, ownership: 'tool-owned' })
  const scaffold = (path: string, content: string): FileSpec => ({ path, content, ownership: 'scaffold' })

  return [
    scaffold('package.json', packageJson(vars)),
    toolOwned('nx.json', nxJson(vars)),
    toolOwned('tsconfig.base.json', tsconfigBase()),
    toolOwned('tsconfig.jest.json', tsconfigJest()),
    toolOwned('jest.config.mjs', jestConfigMjs),
    toolOwned('jest.preset.mjs', jestPresetMjs),
    toolOwned('jest.setup.mjs', jestSetupMjs),
    toolOwned('jest.clear.mjs', jestClearMjs),
    toolOwned('eslint.config.mjs', readAsset('eslint.config.mjs')),
    toolOwned('typedoc.json', typedocJson()),
    scaffold('.npmrc', npmrc(vars)),
    toolOwned('.editorconfig', editorconfig),
    scaffold('.gitignore', gitignore),
    toolOwned('commitlint.config.mjs', commitlintConfigMjs),
    scaffold('.husky/commit-msg', huskyCommitMessage),
    scaffold('README.md', readme(vars)),
    scaffold('docs/nx-release.md', nxReleaseDocument(vars)),
    toolOwned(`${vars.displayName}.code-workspace`, codeWorkspace(vars)),
    ...pipelineFiles(),
    // Keep apps/ and libs/ present even before any project is added.
    scaffold('apps/.gitkeep', ''),
    scaffold('libs/.gitkeep', ''),
  ]
}
