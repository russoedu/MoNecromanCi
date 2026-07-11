import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyFiles } from './engine/apply'
import { readAsset } from './engine/assets'
import { configFromVars, saveConfig } from './engine/config'
import { discoverProjects } from './engine/projects'
import { syncToolOwned } from './engine/sync'
import type { MonorepoVars } from './engine/types'
import { generateProject, projectFiles } from './generators/scaffold'
import { monorepoFiles } from './templates/monorepo'

const vars: MonorepoVars = {
  workspaceName:   'demo',
  displayName:     'Demo',
  scope:           '@demo',
  defaultBase:     'main',
  nodeVersion:     '24',
  ci:              'azure',
  registry:        { kind: 'azure-artifacts', organization: 'org', project: 'Automation', artifactsFeed: 'FEED' },
  triggerBranches: ['dev', 'main'],
}

let repo: string

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'monecromanci-'))
  applyFiles(repo, monorepoFiles(vars))
  saveConfig(repo, configFromVars(vars))

  const config = configFromVars(vars)
  generateProject(repo, 'internal-lib', 'helpers', config)
  generateProject(repo, 'publishable-lib', 'sdk', config)
  generateProject(repo, 'cli-tool', 'mytool', config)
  generateProject(repo, 'function-app', 'api', config)
  generateProject(repo, 'node-app', 'svc', config)
  generateProject(repo, 'react-app', 'web', config)
  generateProject(repo, 'vue-app', 'shop', config)
  generateProject(repo, 'svelte-app', 'widget', config)
  generateProject(repo, 'nextjs-app', 'portal', config)
})

afterAll(() => {
  if (repo) {
    rmSync(repo, { recursive: true, force: true })
  }
})

const read = (path: string): string => readFileSync(join(repo, path), 'utf8')
const hasPath = (path: string): boolean => existsSync(join(repo, path))
function readJson<T> (path: string): T {
  return JSON.parse(read(path)) as T
}

describe('monorepo scaffolding', () => {
  it('writes the central configs and vendored pipeline', () => {
    expect(hasPath('nx.json')).toBe(true)
    expect(hasPath('eslint.config.mjs')).toBe(true)
    expect(hasPath('Demo.code-workspace')).toBe(true)
    expect(hasPath('azure-pipelines.yml')).toBe(true)
    expect(hasPath('.build-templates/03-package-apps.mjs')).toBe(true)
    expect(hasPath('docs/nx-release.md')).toBe(true)
  })

  it('no longer vendors configs now referenced from the monecromanci package', () => {
    for (const path of ['tsconfig.base.json', 'tsconfig.jest.json', 'jest.preset.mjs', 'jest.setup.mjs', 'jest.clear.mjs', 'typedoc.json']) {
      expect(hasPath(path)).toBe(false)
    }
  })

  it('re-exports the canonical ESLint config from the monecromanci package', () => {
    const eslintConfig = read('eslint.config.mjs')
    expect(eslintConfig).toMatch(/export \{ default \} from 'monecromanci\/eslint\.config\.mjs'/)
  })

  it('enables source maps in the package\'s own jest tsconfig (debug requirement)', () => {
    const tsconfig = JSON.parse(readAsset('tsconfig.jest.json')) as { compilerOptions: { sourceMap: boolean } }
    expect(tsconfig.compilerOptions.sourceMap).toBe(true)
  })

  it('configures nx release with the current (non-deprecated) tag schema and a disk fallback', () => {
    const nxConfig = readJson<{ release: {
      releaseTagPattern?: string
      releaseTag?:        { pattern?: string }
      version:            { conventionalCommits?: boolean, fallbackCurrentVersionResolver?: string }
    } }>('nx.json')

    // The flat `releaseTagPattern` key was removed in Nx 23 (moved to nested
    // `releaseTag.pattern`); keeping it breaks `nx release version` entirely.
    expect(nxConfig.release.releaseTagPattern).toBeUndefined()
    expect(nxConfig.release.releaseTag?.pattern).toBe('{projectName}@{version}')
    expect(nxConfig.release.version.conventionalCommits).toBe(true)
    // A brand-new project (or one adopted with no seeded baseline tag) has no
    // matching git tag yet; this lets version resolution fall back to disk
    // instead of nx release version hard-erroring.
    expect(nxConfig.release.version.fallbackCurrentVersionResolver).toBe('disk')
  })

  it('builds each project before nx release publish and resolves the dist manifest as its package root', () => {
    const nxConfig = readJson<{ targetDefaults: {
      'nx-release-publish'?: { dependsOn?: string[], options?: { packageRoot?: string } }
    } }>('nx.json')

    expect(nxConfig.targetDefaults['nx-release-publish']?.dependsOn).toEqual(['build'])
    expect(nxConfig.targetDefaults['nx-release-publish']?.options?.packageRoot).toBe('dist/{projectRoot}')
  })

  it('pins @nx/js so nx release can version JS/TS projects', () => {
    const package_ = readJson<{ devDependencies: Record<string, string> }>('package.json')
    expect(package_.devDependencies['@nx/js']).toBeDefined()
  })

  it('adds monecromanci itself as a devDependency, and eslint (the binary) without its plugin packages', () => {
    const package_ = readJson<{ devDependencies: Record<string, string> }>('package.json')
    expect(package_.devDependencies.monecromanci).toBeDefined()
    expect(package_.devDependencies.eslint).toBeDefined()
    for (const name of ['eslint-plugin-jest', 'eslint-plugin-unicorn', '@stylistic/eslint-plugin', '@eslint/markdown', 'globals', 'typescript-eslint']) {
      expect(package_.devDependencies[name]).toBeUndefined()
    }
  })

  it('places launch at the workspace top level with a breakpoint-capable jest config', () => {
    const workspace = readJson<{
      launch?:  { configurations: Array<Record<string, unknown>> }
      settings: Record<string, unknown>
    }>('Demo.code-workspace')

    expect(workspace.launch).toBeDefined()
    expect(workspace.settings.launch).toBeUndefined()

    const jestConfig = workspace.launch?.configurations.find((config) => config.name === 'Debug Jest (current file)')
    expect(jestConfig?.args).toContain('--runInBand')
    expect(jestConfig?.resolveSourceMapLocations).toBeNull()
    expect(jestConfig?.disableOptimisticBPs).toBe(true)
  })
})

describe('project generation', () => {
  it('resolves an internal lib to its TypeScript source', () => {
    const package_ = readJson<{ main: string }>('libs/helpers/package.json')
    expect(package_.main).toBe('./src/index.ts')
    const project = readJson<{ tags: string[] }>('libs/helpers/project.json')
    expect(project.tags).toContain('type:internal-lib')
  })

  it('extends every project\'s tsconfig/jest/typedoc from the monecromanci package, not a local file', () => {
    const tsconfig = readJson<{ extends: string }>('libs/helpers/tsconfig.json')
    expect(tsconfig.extends).toBe('monecromanci/tsconfig.base.json')

    const jestConfig = read('libs/helpers/jest.config.mjs')
    expect(jestConfig).toContain('from \'monecromanci/jest.preset.mjs\'')

    const typedoc = readJson<{ extends: string[] }>('libs/helpers/typedoc.json')
    expect(typedoc.extends).toEqual(['monecromanci/typedoc.json'])
  })

  it('ships function-app configurations, clean:config and a root @azure/functions dep', () => {
    expect(hasPath('apps/api/.configurations/dev.json')).toBe(true)
    expect(hasPath('apps/api/.configurations/uat.json')).toBe(true)
    expect(hasPath('apps/api/.configurations/prod.json')).toBe(true)
    expect(hasPath('tools/clean-config.mjs')).toBe(true)
    const root = readJson<{ dependencies: Record<string, string> }>('package.json')
    expect(root.dependencies['@azure/functions']).toBeDefined()
  })

  it('gives the react app multi-env builds and adds react deps to the root', () => {
    const package_ = readJson<{ scripts: Record<string, string> }>('apps/web/package.json')
    expect(package_.scripts['build:all']).toContain('build:uat')
    expect(hasPath('apps/web/.env.uat')).toBe(true)
    const root = readJson<{ dependencies: Record<string, string>, devDependencies: Record<string, string> }>('package.json')
    expect(root.dependencies.react).toBeDefined()
    expect(root.devDependencies.vite).toBeDefined()
  })

  it('marks a cli tool with a bin and the resolved-deps script', () => {
    const package_ = readJson<{ bin: Record<string, string> }>('libs/mytool/package.json')
    expect(package_.bin.mytool).toBe('./dist/cli.js')
    expect(hasPath('tools/generate-dist-package.mjs')).toBe(true)
  })

  it('scaffolds a generic node app tagged type:node-app with a tsx dev dependency', () => {
    expect(hasPath('apps/svc/src/index.ts')).toBe(true)
    expect(readJson<{ tags: string[] }>('apps/svc/project.json').tags).toContain('type:node-app')
    expect(readJson<{ devDependencies: Record<string, string> }>('package.json').devDependencies.tsx).toBeDefined()
  })

  it('scaffolds Vue and Svelte apps with their SFCs and root deps', () => {
    expect(hasPath('apps/shop/src/App.vue')).toBe(true)
    expect(hasPath('apps/widget/src/App.svelte')).toBe(true)
    expect(readJson<{ tags: string[] }>('apps/shop/project.json').tags).toContain('type:vue-app')
    expect(readJson<{ tags: string[] }>('apps/widget/project.json').tags).toContain('type:svelte-app')
    const root = readJson<{ dependencies: Record<string, string>, devDependencies: Record<string, string> }>('package.json')
    expect(root.dependencies.vue).toBeDefined()
    expect(root.devDependencies.svelte).toBeDefined()
  })

  it('scaffolds a full-stack Next.js app with the multi-env build script', () => {
    expect(hasPath('apps/portal/src/app/page.tsx')).toBe(true)
    expect(hasPath('tools/next-build.mjs')).toBe(true)
    expect(readJson<{ tags: string[] }>('apps/portal/project.json').tags).toContain('type:nextjs-app')
    const package_ = readJson<{ scripts: Record<string, string> }>('apps/portal/package.json')
    expect(package_.scripts['build:all']).toContain('build:uat')
    expect(readJson<{ dependencies: Record<string, string> }>('package.json').dependencies.next).toBeDefined()
  })
})

describe('CI providers', () => {
  const pathsFor = (ci: MonorepoVars['ci']): Set<string> => new Set(monorepoFiles({ ...vars, ci }).map((file) => file.path))

  it('emits only the Azure pipeline for ci=azure', () => {
    const paths = pathsFor('azure')
    expect(paths.has('azure-pipelines.yml')).toBe(true)
    expect(paths.has('.github/workflows/ci.yml')).toBe(false)
  })

  it('emits only the GitHub workflow for ci=github', () => {
    const paths = pathsFor('github')
    expect(paths.has('.github/workflows/ci.yml')).toBe(true)
    expect(paths.has('azure-pipelines.yml')).toBe(false)
  })

  it('emits both workflows for ci=both and always vendors the shared engine', () => {
    const paths = pathsFor('both')
    expect(paths.has('azure-pipelines.yml')).toBe(true)
    expect(paths.has('.github/workflows/ci.yml')).toBe(true)
    expect(paths.has('.build-templates/03-package-apps.mjs')).toBe(true)
  })

  it('renders the configured trigger branches into both pipeline files', () => {
    const files = monorepoFiles({ ...vars, ci: 'both', triggerBranches: ['main', 'release'] })
    const azurePipelines = files.find((file) => file.path === 'azure-pipelines.yml')?.content ?? ''
    const githubWorkflow = files.find((file) => file.path === '.github/workflows/ci.yml')?.content ?? ''

    expect(azurePipelines).toMatch(/trigger:\n {2}branches:\n {4}include: \[main, release\]/)
    expect(azurePipelines).toMatch(/pr:\n {2}branches:\n {4}include: \[main, release\]/)
    expect(githubWorkflow).toContain('branches: [main, release]')
    expect(azurePipelines).not.toContain('dev, development, uat, master')
    expect(githubWorkflow).not.toContain('dev, development, uat, master')
  })
})

describe('registry', () => {
  const npmrcFor = (registry: MonorepoVars['registry']): string =>
    monorepoFiles({ ...vars, registry }).find((file) => file.path === '.npmrc')?.content ?? ''

  it('scopes GitHub Packages at npm.pkg.github.com', () => {
    expect(npmrcFor({ kind: 'github-packages', owner: 'acme' })).toContain('@demo:registry=https://npm.pkg.github.com/')
  })

  it('scopes Azure Artifacts at the configured feed', () => {
    expect(npmrcFor(vars.registry)).toContain('pkgs.dev.azure.com/org/Automation/_packaging/FEED/npm/registry/')
  })
})

describe('publish pipeline', () => {
  it('delegates publishing to nx release publish instead of hand-rolling npm publish', () => {
    const pipeline = read('.build-templates/04-publish-libs.mjs')

    // Nx's own nx-release-publish executor already resolves the dist-vs-root
    // manifest (via the target's packageRoot option in nx.json), builds first
    // (dependsOn: ['build']), and skips anything already on the registry — no
    // need to hand-roll any of that here.
    expect(pipeline).toMatch(/nx release publish --projects=.* --verbose/)
    expect(pipeline).not.toMatch(/\bpublish --userconfig/)
    expect(pipeline).not.toMatch(/isVersionPublished/)
  })

  it('refuses to publish a manifest with a publish-lifecycle-hook script', () => {
    const pipeline = read('.build-templates/04-publish-libs.mjs')

    // npm auto-runs "publish"/"postpublish"/"prepublish" as lifecycle hooks right
    // after the upload; a mismatched one fails the command post-hoc. Must be
    // caught up front, before the registry is ever touched — Nx's own publish
    // executor doesn't guard against this, so it's still worth doing by hand.
    expect(pipeline).toMatch(/lifecycleHookNames = \['prepublish', 'publish', 'postpublish'\]/)
    expect(pipeline).toMatch(/collidingHook/)
  })

  it('bumps and tags (never commits) affected publishable projects via nx release before publishing', () => {
    const pipeline = read('.build-templates/04-publish-libs.mjs')

    // Scoped to the affected publishable projects, computed from conventional
    // commits since each one's last release tag; tags + pushes the tag only,
    // on both providers — both GitHub and Azure DevOps repos commonly protect
    // the release branch against direct pushes, which rejects the atomic
    // commit+tag push nx would otherwise attempt.
    expect(pipeline).toMatch(/nx release version --projects=.* --no-git-commit --git-tag --git-push\b/)
    expect(pipeline).not.toMatch(/--git-commit\b/)
    // Versioning must run before the publish call, not after.
    expect(pipeline.indexOf('bumpVersions(publishableLibraries)')).toBeLessThan(pipeline.indexOf('publishLibraries(publishableLibraries)'))
  })

  it('re-attaches Azure\'s detached HEAD before the release step runs, in a single self-contained pipeline file', () => {
    const pipeline = read('azure-pipelines.yml')

    // `checkout: self` leaves Azure Pipelines on a detached HEAD; re-attach right
    // after checkout, before anything else runs. Everything else (the six former
    // .build-templates/NN-*.yml step-template wrappers) is inlined directly here
    // too, mirroring how ci.yml is already a single self-contained file.
    const checkoutIndex = pipeline.indexOf('checkout: self')
    const attachIndex = pipeline.indexOf('git checkout -B $(Build.SourceBranchName)')
    const fetchReferencesIndex = pipeline.indexOf('[01] Fetch all refs for affected detection')
    const publishIndex = pipeline.indexOf('[04] Publish affected libraries')
    const summaryIndex = pipeline.indexOf('[06] Publish build summary')

    expect(checkoutIndex).toBeGreaterThan(-1)
    expect(attachIndex).toBeGreaterThan(checkoutIndex)
    expect(fetchReferencesIndex).toBeGreaterThan(attachIndex)
    expect(publishIndex).toBeGreaterThan(fetchReferencesIndex)
    expect(summaryIndex).toBeGreaterThan(publishIndex)
    expect(hasPath('.build-templates/01-preparation.yml')).toBe(false)
    expect(hasPath('.build-templates/04-publish-libs.yml')).toBe(false)
  })
})

describe('doctor', () => {
  it('reports zero drift immediately after generation (templates are idempotent)', () => {
    const config = configFromVars(vars)
    const specs = [...monorepoFiles(vars)]
    for (const project of discoverProjects(repo, config)) {
      specs.push(...projectFiles(project.kind, project))
    }

    const report = syncToolOwned(repo, specs, false)
    expect(report.missing).toEqual([])
    expect(report.drift).toEqual([])
  })
})
