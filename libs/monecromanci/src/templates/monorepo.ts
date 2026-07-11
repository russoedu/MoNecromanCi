/* eslint-disable no-template-curly-in-string -- this file builds file templates that legitimately embed ${...} placeholders (VSCode variables, auth tokens). */
import { listAssetFiles, readAsset } from '../engine/assets'
import { toJson } from '../engine/fsx'
import { npmrcContent } from '../engine/registry'
import type { FileSpec, MonorepoVars, RegistryConfig } from '../engine/types'
import rootPackageJson from '../../package.json'

/** Looks up a toolchain version from this package's own devDependencies. */
const sharedDependency = (name: keyof typeof rootPackageJson.devDependencies): string => rootPackageJson.devDependencies[name]

/**
 * Pinned toolchain for generated monorepos (mirrors the proven JATO set).
 *
 * @remarks
 * Shared entries (TS/Jest toolchain) reuse the exact versions MoNecromanCI
 * itself depends on, sourced from this package's own `devDependencies`, so the
 * two never drift apart. Generated-repo-only packages (nx, esbuild, husky, the
 * commitlint/typedoc tooling) are pinned here directly since MoNecromanCI has no
 * use for them itself. Exported so `resurrect` can force-pin these versions in
 * an adopted repo.
 *
 * The ESLint *plugin* packages (`eslint-plugin-*`, `@stylistic/eslint-plugin`,
 * `@eslint/markdown`, `globals`, `typescript-eslint`) are deliberately **not**
 * listed here: `eslint.config.mjs` is now a thin re-export of
 * `monecromanci/eslint.config.mjs`, and Node resolves that file's own `import`
 * statements from *inside* `node_modules/monecromanci`'s own dependency tree
 * regardless of what the consuming repo declares — so those plugins never
 * need to be the consumer's own devDependencies. `eslint` itself stays listed
 * because it's invoked as a **binary** (`eslint . -c ...`), which needs
 * `node_modules/.bin/eslint` to exist at the consumer's own top level.
 */
export const DEV_DEPENDENCIES: Record<string, string> = {
  '@commitlint/cli':                 '^21.1.0',
  '@commitlint/config-conventional': '^21.1.0',
  '@nx/js':                          '^23.0.1',
  '@types/jest':                     sharedDependency('@types/jest'),
  '@types/node':                     sharedDependency('@types/node'),
  esbuild:                           '^0.28.1',
  eslint:                            sharedDependency('eslint'),
  husky:                             '^9.1.7',
  jest:                              sharedDependency('jest'),
  'jest-junit':                      '^17.0.0',
  monecromanci:                      `^${rootPackageJson.version}`,
  nx:                                '^23.0.1',
  'ts-jest':                         sharedDependency('ts-jest'),
  'tsc-alias':                       '^1.8.17',
  tslib:                             '^2.8.1',
  typedoc:                           '^0.28.19',
  'typedoc-plugin-missing-exports':  '^4.1.3',
  typescript:                        sharedDependency('typescript'),
}

/** Builds the root package.json: workspaces, shared scripts and pinned toolchain. */
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

/** Builds nx.json with shared cache inputs, target defaults and release config. */
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
      build:                { dependsOn: ['^build'], inputs: ['production', '^production'], cache: true },
      lint:                 { inputs: ['default', '^production'], cache: true },
      test:                 { dependsOn: ['build'], inputs: ['default', '^production'], cache: true },
      doc:                  { inputs: ['production', '^production'], cache: true },
      'nx-release-publish': { dependsOn: ['build'], options: { packageRoot: 'dist/{projectRoot}' } },
    },
    release: {
      projectsRelationship: 'independent',
      projects:             ['tag:type:publishable-lib'],
      releaseTag:           { pattern: '{projectName}@{version}' },
      version:              { conventionalCommits: true, fallbackCurrentVersionResolver: 'disk' },
      changelog:            { projectChangelogs: true },
    },
    analytics: false,
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

// Thin wrapper re-exporting the canonical config from the monecromanci package
// itself (tsconfig.base.json, tsconfig.jest.json, jest.preset.mjs and
// typedoc.json are no longer vendored locally either — see 'monecromanci/...'
// references throughout the per-project templates).
const eslintConfigWrapper = `// ESLint flat config — generated by MoNecromanCI. Re-sync with 'monecromanci doctor'.
export { default } from 'monecromanci/eslint.config.mjs'
`

/** Builds the root .npmrc for the configured publish registry. */
function npmrc (vars: MonorepoVars): string {
  return npmrcContent(vars.registry, vars.scope)
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
.next/
next-env.d.ts
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

/** Builds the generated repo's README.md. */
function readme (vars: MonorepoVars): string {
  return `# ${vars.displayName}

NX monorepo generated by [MoNecromanCI](https://github.com/russoedu/monecromanci).

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
npx monecromanci add    # (alias: conjure) function-app | node-app | react-app | vue-app | svelte-app | nextjs-app | internal-lib | publishable-lib | cli-tool
\`\`\`
`
}

/** Human label for a registry, used in the generated nx-release doc. */
function registryLabelFor (registry: RegistryConfig): string {
  switch (registry.kind) {
    case 'azure-artifacts': {
      return 'the Azure Artifacts feed `' + registry.artifactsFeed + '`'
    }
    case 'github-packages': {
      return 'GitHub Packages'
    }
    default: {
      return 'the public npm registry'
    }
  }
}

/** Builds the nx-release how-to document for the configured registry. */
function nxReleaseDocument (vars: MonorepoVars): string {
  const registryLabel = registryLabelFor(vars.registry)
  const distPackageRootToken = '{projectRoot}'

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
npm run release:publish    # publish what changed to the configured registry
npx nx release --dry-run   # preview everything, change nothing
\`\`\`

## What gets published

\`build\` emits \`dist/\` and runs \`tools/generate-dist-package.mjs\`, which writes a
correct \`dist/package.json\`: it resolves real dependency versions from the **root**
package.json (all deps live there) and from internal workspace packages. This is
why published packages declare their dependencies even though project
\`package.json\` files keep \`dependencies: {}\`.

Publishing itself is delegated to \`nx release publish\`, which builds each
project first (the \`nx-release-publish\` target's \`dependsOn: ['build']\` in
\`nx.json\`), resolves what to publish from that target's \`packageRoot\` option
(\`dist/${distPackageRootToken}\` by default), and natively skips anything already on the
registry. A project that packages itself from its root instead (e.g. a bundled
CLI with a \`files\` allow-list) overrides \`packageRoot\` to \`${distPackageRootToken}\` in its own
\`project.json\`.

## First release

A brand-new project has no release tag yet, so version resolution falls back to
whatever is on disk (the scaffold \`0.0.0\`) and bumps from there — no manual step
needed. To force a specific starting version instead:

\`\`\`sh
npx nx release version 1.0.0 --projects=my-lib --first-release
\`\`\`

## CI

On \`${vars.defaultBase}\` (non-PR builds), the publish step (\`04-publish-libs\`)
scopes \`nx release version\` to the affected publishable projects, letting it
compute each one's bump from conventional commits and create a release tag
(the \`release.releaseTag.pattern\` from \`nx.json\`) — then publishes the newly
versioned projects to ${registryLabel}. A project with no releasable commits
since its last tag is left untouched.

The version bump is **never committed** — only the tag is pushed back to
\`${vars.defaultBase}\`. Both GitHub and Azure DevOps repos commonly protect the
release branch against direct pushes, which rejects the atomic commit+tag
push \`nx release\` would otherwise attempt; skipping the commit (\`--no-git-commit\`)
means nothing is pushed to the branch itself, so a protected \`${vars.defaultBase}\`
never rejects the release. Future runs still resolve versions correctly since
\`nx release\` reads the version straight from the tag name, not from a
committed \`package.json\`.

This needs write access back to the repository:

- **GitHub Actions**: the workflow's \`permissions.contents\` must be \`write\`
  (already set by this template).
- **Azure DevOps**: the pipeline's checkout already sets \`persistCredentials:
  true\`, but the **Project Collection Build Service** account additionally needs
  **Contribute** permission on the repo — a one-time setting under *Project
  Settings → Repositories → Security* that only a project admin can grant (tag
  creation still needs this even though the branch itself is never pushed to).
`
}

/** Builds the VSCode .code-workspace file. */
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
          // Function App: run `func start` (inspects via local.settings.json), then attach.
          // Node app: run `node --inspect=9229 dist/index.js` (after build), then attach;
          // or run `npm run dev -w <app>` in a JavaScript Debug Terminal for source-level tsx.
          name:                      'Debug Function/Node App (attach :9229)',
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
          name:                      'Debug React/Vue/Svelte (Edge)',
          type:                      'msedge',
          request:                   'launch',
          url:                       'http://localhost:5173',
          webRoot:                   '${workspaceFolder}',
          sourceMaps:                true,
          resolveSourceMapLocations: null,
        },
        {
          // Next.js dev server runs on :3000. For server-side breakpoints, run
          // `npm run dev -w <app>` in a JavaScript Debug Terminal instead.
          name:                      'Debug Next.js (Edge)',
          type:                      'msedge',
          request:                   'launch',
          url:                       'http://localhost:3000',
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

/** The literal branch list baked into the vendored GitHub Actions asset, replaced with the configured one. */
const DEFAULT_TRIGGER_BRANCHES_LITERAL = '[dev, development, uat, master, main]'

/** Formats a branch list as a YAML flow sequence, e.g. `[main, dev]`. */
function branchList (branches: string[]): string {
  return `[${branches.join(', ')}]`
}

/**
 * Builds `azure-pipelines.yml` as a single self-contained file — every stage's
 * steps inlined directly (mirroring how `.github/workflows/ci.yml` already
 * works), instead of a chain of six separate `.build-templates/NN-*.yml`
 * step-template wrappers.
 */
function azurePipelinesYaml (vars: MonorepoVars): string {
  const branches = branchList(vars.triggerBranches)

  return `name: monorepo-ci-$(Date:yyyyMMdd)$(Rev:.r)

# Generated by MoNecromanCI. Re-sync the build-templates with 'monecromanci doctor'.
trigger:
  branches:
    include: ${branches}
  paths:
    exclude: [docs/**, "**/*.md"]

pr:
  branches:
    include: ${branches}
  paths:
    exclude: [docs/**, "**/*.md"]

pool:
  name: AzurePipelineManagedPool-Windows
  demands:
    - npm

variables:
  # Set to an Azure Resource Manager service connection to publish TypeDoc to a
  # Storage blob; leave empty to skip documentation publishing.
  - name: docsAzureSubscription
    value: ""

steps:
  - checkout: self
    fetchDepth: 0
    persistCredentials: true

  # Azure Pipelines checks out the build SHA in detached HEAD state by default
  # (unlike GitHub Actions) — attach it to a real branch for general hygiene
  # and debuggability. (04-publish-libs's tag-only push on Azure no longer
  # strictly needs this, but it's harmless to keep.)
  - script: git checkout -B $(Build.SourceBranchName)
    displayName: "[01] Attach HEAD to the source branch (Azure checkout detaches by default)"

  - task: PowerShell@2
    displayName: "[01] Fetch all refs for affected detection"
    inputs:
      targetType: inline
      script: |
        Write-Host "=== Fetching all refs and tags ===" -ForegroundColor Cyan
        git fetch --all --prune --tags
        Write-Host "=== Recent commits ===" -ForegroundColor Cyan
        git log --oneline -10

  - task: UseNode@1
    displayName: "[01] Use Node.js 24"
    inputs:
      version: 24.x

  - task: PowerShell@2
    displayName: "[01] Ensure npm cache directory exists"
    inputs:
      targetType: inline
      script: New-Item -ItemType Directory -Path "$(Pipeline.Workspace)/.npm" -Force | Out-Null

  - task: Cache@2
    displayName: "[01] Restore npm cache"
    inputs:
      key: npm | "$(Agent.OS)" | $(Build.SourcesDirectory)/package-lock.json
      restoreKeys: |
        npm | "$(Agent.OS)"
      path: $(Pipeline.Workspace)/.npm

  # Authenticate against the registries declared in the repo's .npmrc. This
  # injects credentials so the plain \`npm ci\` below works for any feed/registry.
  - task: npmAuthenticate@0
    displayName: "[01] Authenticate npm registry"
    inputs:
      workingFile: .npmrc

  # Dependencies are installed BEFORE affected detection so Nx computes the
  # project graph with the workspace's pinned Nx version (never a downloaded one).
  - script: npm ci
    displayName: "[01] Install monorepo dependencies"
    workingDirectory: $(Build.SourcesDirectory)
    env:
      HUSKY: 0

  - script: node .build-templates/01-preparation.mjs
    displayName: "[01] Resolve context, affected projects and execution plan"

  - script: node .build-templates/02-quality-control.mjs
    displayName: "[02] Run affected projects lint, test and build"
    condition: and(succeeded(), eq(variables['HAS_AFFECTED'], 'true'))

  - task: PublishTestResults@2
    displayName: "[02] Publish affected projects test results"
    condition: and(succeededOrFailed(), eq(variables['HAS_AFFECTED'], 'true'))
    inputs:
      testResultsFormat: JUnit
      testResultsFiles: "**/coverage/test-results.xml"
      searchFolder: $(Build.SourcesDirectory)
      mergeTestResults: true
      failTaskOnFailedTests: true
      testRunTitle: Affected Tests

  - task: PublishCodeCoverageResults@2
    displayName: "[02] Publish affected projects coverage results"
    condition: and(succeededOrFailed(), eq(variables['HAS_AFFECTED'], 'true'))
    inputs:
      summaryFileLocation: "$(Build.SourcesDirectory)/**/coverage/cobertura-coverage.xml"
      pathToSources: $(Build.SourcesDirectory)
      reportDirectory: "$(Build.SourcesDirectory)/**/coverage"
      failIfCoverageEmpty: false

  - script: node .build-templates/03-package-apps.mjs
    displayName: "[03] Build, package and stage affected apps"
    condition: >
      and(succeeded(),
          or(eq(variables['HAS_FUNCTION_APPS'], 'true'),
             eq(variables['HAS_NODE_APPS'], 'true'),
             eq(variables['HAS_REACT_APPS'], 'true')))

  - task: PublishBuildArtifacts@1
    displayName: "[03] Publish function app artifacts"
    condition: and(succeeded(), eq(variables['HAS_FUNCTION_APPS'], 'true'))
    inputs:
      PathtoPublish: $(Build.ArtifactStagingDirectory)/function-apps
      ArtifactName: drop-function-apps

  - task: PublishPipelineArtifact@1
    displayName: "[03] Publish function app configurations"
    condition: and(succeeded(), eq(variables['HAS_FUNCTION_APPS'], 'true'))
    inputs:
      targetPath: $(Build.ArtifactStagingDirectory)/function-app-configurations
      artifact: config-function-apps
      publishLocation: pipeline

  - task: PublishBuildArtifacts@1
    displayName: "[03] Publish Node app artifacts"
    condition: and(succeeded(), eq(variables['HAS_NODE_APPS'], 'true'))
    inputs:
      PathtoPublish: $(Build.ArtifactStagingDirectory)/node-apps
      ArtifactName: drop-node-apps

  - task: PublishBuildArtifacts@1
    displayName: "[03] Publish React app artifacts"
    condition: and(succeeded(), eq(variables['HAS_REACT_APPS'], 'true'))
    inputs:
      PathtoPublish: $(Build.ArtifactStagingDirectory)/react-apps
      ArtifactName: drop-react-apps

  - task: npmAuthenticate@0
    displayName: "[04] Authenticate npm registry"
    condition: and(succeeded(), eq(variables['HAS_PUBLISHABLE_LIBS'], 'true'))
    inputs:
      workingFile: .npmrc

  # Versions are computed by \`nx release version\` from conventional commits. On
  # GitHub Actions this commits, tags and pushes both back to the branch; on
  # Azure DevOps the commit is skipped and only the tag is pushed, so a
  # protected release branch never rejects the push — see \`04-publish-libs.mjs\`.
  # Requires the "Project Collection Build Service" account to have Contribute
  # permission on this repo (Project Settings -> Repositories -> Security)
  # since the checkout's persistCredentials is what lets the script push. Runs
  # on a publish branch (master or main) for non-PR builds; the script
  # re-checks these.
  - script: node .build-templates/04-publish-libs.mjs
    displayName: "[04] Publish affected libraries"
    condition: >
      and(succeeded(),
          eq(variables['HAS_PUBLISHABLE_LIBS'], 'true'),
          ne(variables['Build.Reason'], 'PullRequest'),
          or(eq(variables['Build.SourceBranchName'], 'master'),
             eq(variables['Build.SourceBranchName'], 'main')))
    env:
      NODE_AUTH_TOKEN: $(NODE_AUTH_TOKEN)

  - task: AzureCLI@2
    displayName: "[05] Build and publish affected library documentation"
    # Skipped entirely unless a docs service connection is configured.
    condition: >
      and(succeeded(),
          ne(variables['docsAzureSubscription'], ''),
          or(eq(variables['HAS_INTERNAL_PACKAGES'], 'true'),
             eq(variables['HAS_PUBLISHABLE_LIBS'], 'true')))
    env:
      BUILD_DEFINITIONNAME: $(Build.DefinitionName)
      MONOREPO_CONTEXT_FILE: $(MONOREPO_CONTEXT_FILE)
      NX_BASE: $(NX_BASE)
      NX_HEAD: $(NX_HEAD)
      saDevConnectionString: $(saDevConnectionString)
    inputs:
      azureSubscription: $(docsAzureSubscription)
      scriptType: pscore
      scriptLocation: inlineScript
      inlineScript: node .build-templates/05-publish-documentation.mjs

  - script: node .build-templates/06-summary.mjs
    displayName: "[06] Publish build summary"
    condition: succeededOrFailed()
`
}

/** Builds `.github/workflows/ci.yml`, substituting the configured CI trigger branches. */
function githubCiYaml (vars: MonorepoVars): string {
  return readAsset('github/workflows/ci.yml').replaceAll(DEFAULT_TRIGGER_BRANCHES_LITERAL, () => branchList(vars.triggerBranches))
}

/**
 * Vendored CI: the shared `.build-templates` engine (always) plus the workflow
 * wrapper(s) for the selected provider(s) — Azure Pipelines and/or GitHub Actions.
 *
 * @remarks
 * `.yml` files are excluded from the vendored engine: Azure's per-stage step
 * templates (`01-preparation.yml`, etc.) are inlined directly into
 * {@link azurePipelinesYaml} instead (mirroring GitHub's single-file
 * `ci.yml`), and GitHub Actions never referenced them at all.
 */
function pipelineFiles (vars: MonorepoVars): FileSpec[] {
  const files: FileSpec[] = Array.from(listAssetFiles('build-templates'), relativePath => relativePath)
    .filter((relativePath) => !relativePath.endsWith('.yml'))
    .map((relativePath) => ({
      path:      `.build-templates/${relativePath}`,
      content:   readAsset(`build-templates/${relativePath}`),
      ownership: 'tool-owned' as const,
    }))

  if (vars.ci === 'azure' || vars.ci === 'both') {
    files.push({ path: 'azure-pipelines.yml', content: azurePipelinesYaml(vars), ownership: 'tool-owned' })
  }

  if (vars.ci === 'github' || vars.ci === 'both') {
    files.push({ path: '.github/workflows/ci.yml', content: githubCiYaml(vars), ownership: 'tool-owned' })
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
    toolOwned('jest.config.mjs', jestConfigMjs),
    toolOwned('eslint.config.mjs', eslintConfigWrapper),
    scaffold('.npmrc', npmrc(vars)),
    toolOwned('.editorconfig', editorconfig),
    scaffold('.gitignore', gitignore),
    toolOwned('commitlint.config.mjs', commitlintConfigMjs),
    scaffold('.husky/commit-msg', huskyCommitMessage),
    scaffold('README.md', readme(vars)),
    toolOwned('MoNecromanCi.md', readAsset('MoNecromanCi.md')),
    scaffold('docs/nx-release.md', nxReleaseDocument(vars)),
    toolOwned(`${vars.displayName}.code-workspace`, codeWorkspace(vars)),
    ...pipelineFiles(vars),
    // Keep apps/ and libs/ present even before any project is added.
    scaffold('apps/.gitkeep', ''),
    scaffold('libs/.gitkeep', ''),
  ]
}
