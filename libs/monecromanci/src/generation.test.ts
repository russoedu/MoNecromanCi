import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyFiles } from './engine/apply'
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
const readToolchainAsset = (path: string): string => readFileSync(join(__dirname, '../../monecromanci-toolchain', path), 'utf8')

describe('monorepo scaffolding', () => {
  it('writes the central configs', () => {
    expect(hasPath('nx.json')).toBe(true)
    expect(hasPath('eslint.config.mjs')).toBe(true)
    expect(hasPath('Demo.code-workspace')).toBe(true)
    expect(hasPath('azure-pipelines.yml')).toBe(true)
    expect(hasPath('docs/nx-release.md')).toBe(true)
  })

  it('no longer vendors configs/scripts now referenced from the monecromanci-toolchain package', () => {
    for (const path of ['tsconfig.base.json', 'tsconfig.jest.json', 'jest.preset.mjs', 'jest.setup.mjs', 'jest.clear.mjs', 'typedoc.json', '.build-templates', 'tools/generate-dist-package.mjs', 'tools/clean-config.mjs', 'tools/next-build.mjs']) {
      expect(hasPath(path)).toBe(false)
    }
  })

  it('re-exports the canonical ESLint config from the monecromanci-toolchain package', () => {
    const eslintConfig = read('eslint.config.mjs')
    expect(eslintConfig).toMatch(/export \{ default \} from 'monecromanci-toolchain\/eslint\.config\.mjs'/)
  })

  it('enables source maps in the package\'s own jest tsconfig (debug requirement)', () => {
    const tsconfig = JSON.parse(readToolchainAsset('tsconfig.jest.json')) as { compilerOptions: { sourceMap: boolean } }
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

  it('adds monecromanci and monecromanci-toolchain as devDependencies, and eslint (the binary) without its plugin packages', () => {
    const package_ = readJson<{ devDependencies: Record<string, string> }>('package.json')
    expect(package_.devDependencies.monecromanci).toBeDefined()
    expect(package_.devDependencies['monecromanci-toolchain']).toBeDefined()
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

  it('extends every project\'s tsconfig/jest/typedoc from the monecromanci-toolchain package, not a local file', () => {
    const tsconfig = readJson<{ extends: string }>('libs/helpers/tsconfig.json')
    expect(tsconfig.extends).toBe('monecromanci-toolchain/tsconfig.base.json')

    const jestConfig = read('libs/helpers/jest.config.mjs')
    expect(jestConfig).toContain('from \'monecromanci-toolchain/jest.preset.mjs\'')

    const typedoc = readJson<{ extends: string[] }>('libs/helpers/typedoc.json')
    expect(typedoc.extends).toEqual(['monecromanci-toolchain/typedoc.json'])
  })

  it('marks every project kind\'s jest.config.mjs as tool-owned, so doctor drift-checks it like tsconfig/typedoc', () => {
    const config = configFromVars(vars)
    const projects = discoverProjects(repo, config)
    expect(projects.length).toBeGreaterThan(0)

    for (const project of projects) {
      const spec = projectFiles(project.kind, project).find((entry) => entry.path.endsWith('/jest.config.mjs'))
      expect(spec?.ownership).toBe('tool-owned')
    }
  })

  it('ships function-app configurations, a clean:config script resolved from node_modules, and a root @azure/functions dep', () => {
    expect(hasPath('apps/api/.configurations/dev.json')).toBe(true)
    expect(hasPath('apps/api/.configurations/uat.json')).toBe(true)
    expect(hasPath('apps/api/.configurations/prod.json')).toBe(true)
    expect(hasPath('tools/clean-config.mjs')).toBe(false)
    const package_ = readJson<{ scripts: Record<string, string> }>('apps/api/package.json')
    expect(package_.scripts['clean:config']).toContain('node_modules/monecromanci-toolchain/scripts/clean-config.mjs')
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

  it('marks a cli tool with a bin, delegating its build to nx, whose target resolves the deps script from node_modules', () => {
    const package_ = readJson<{ bin: Record<string, string>, scripts: Record<string, string> }>('libs/mytool/package.json')
    expect(package_.bin.mytool).toBe('./dist/cli.js')
    // package.json's script is a stable delegator (never needs to change);
    // the real command lives in project.json's tool-owned target instead.
    expect(package_.scripts.build).toBe('nx run mytool:build')
    const project = readJson<{ targets: { build: { options: { command: string, cwd: string } } } }>('libs/mytool/project.json')
    expect(project.targets.build.options.command).toContain('node ../../node_modules/monecromanci-toolchain/scripts/generate-dist-package.mjs')
    expect(project.targets.build.options.cwd).toBe('{projectRoot}')
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

  it('scaffolds a full-stack Next.js app with the multi-env build script resolved from node_modules', () => {
    expect(hasPath('apps/portal/src/app/page.tsx')).toBe(true)
    expect(hasPath('tools/next-build.mjs')).toBe(false)
    expect(readJson<{ tags: string[] }>('apps/portal/project.json').tags).toContain('type:nextjs-app')
    const package_ = readJson<{ scripts: Record<string, string> }>('apps/portal/package.json')
    expect(package_.scripts['build:all']).toContain('build:uat')
    expect(package_.scripts['build:dev']).toContain('node_modules/monecromanci-toolchain/scripts/next-build.mjs')
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

  it('emits both workflows for ci=both, neither vendoring the shared engine', () => {
    const paths = pathsFor('both')
    expect(paths.has('azure-pipelines.yml')).toBe(true)
    expect(paths.has('.github/workflows/ci.yml')).toBe(true)
    expect(paths.has('.build-templates/03-package-apps.mjs')).toBe(false)
  })

  it('calls the shared engine straight out of node_modules/monecromanci-toolchain in both pipeline files', () => {
    const files = monorepoFiles({ ...vars, ci: 'both' })
    const azurePipelines = files.find((file) => file.path === 'azure-pipelines.yml')?.content ?? ''
    const githubWorkflow = files.find((file) => file.path === '.github/workflows/ci.yml')?.content ?? ''

    for (const step of ['01-preparation', '02-quality-control', '03-package-apps', '04-publish-libs', '05-publish-documentation', '06-summary']) {
      const scriptPath = `node_modules/monecromanci-toolchain/build-templates/${step}.mjs`
      expect(azurePipelines).toContain(scriptPath)
      expect(githubWorkflow).toContain(scriptPath)
    }
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
    const pipeline = readToolchainAsset('build-templates/04-publish-libs.mjs')

    // Nx's own nx-release-publish executor already resolves the dist-vs-root
    // manifest (via the target's packageRoot option in nx.json), builds first
    // (dependsOn: ['build']), and skips anything already on the registry — no
    // need to hand-roll any of that here.
    expect(pipeline).toMatch(/nx release publish --projects=.* --verbose/)
    expect(pipeline).not.toMatch(/\bpublish --userconfig/)
    expect(pipeline).not.toMatch(/isVersionPublished/)
  })

  it('refuses to publish a manifest with a publish-lifecycle-hook script', () => {
    const pipeline = readToolchainAsset('build-templates/04-publish-libs.mjs')

    // npm auto-runs "publish"/"postpublish"/"prepublish" as lifecycle hooks right
    // after the upload; a mismatched one fails the command post-hoc. Must be
    // caught up front, before the registry is ever touched — Nx's own publish
    // executor doesn't guard against this, so it's still worth doing by hand.
    expect(pipeline).toMatch(/lifecycleHookNames = \['prepublish', 'publish', 'postpublish'\]/)
    expect(pipeline).toMatch(/collidingHook/)
  })

  it('bumps and tags (never commits) affected publishable projects via nx release before publishing', () => {
    const pipeline = readToolchainAsset('build-templates/04-publish-libs.mjs')

    // Scoped to the affected publishable projects, computed from conventional
    // commits since each one's last release tag; tags only, never commits —
    // both GitHub and Azure DevOps repos commonly protect the release branch
    // against direct pushes, which rejects the atomic commit+tag push nx
    // would otherwise attempt.
    expect(pipeline).toMatch(/nx release version --projects=.* --no-git-commit --git-tag --verbose/)
    expect(pipeline).not.toMatch(/--git-commit\b/)
    // nx's own --git-push is deliberately never passed to the command itself
    // (see the atomic-push test below); the tags are pushed manually instead.
    expect(pipeline).not.toMatch(/--git-tag --git-push\b/)
    // In main(): versioning must run before publishing.
    const bumpCallIndex = pipeline.indexOf('bumpVersions(publishableLibraries, currentBranch())')
    expect(bumpCallIndex).toBeGreaterThan(-1)
    expect(bumpCallIndex).toBeLessThan(pipeline.indexOf('publishLibraries(publishableLibraries)'))
    // Inside bumpVersions() itself: the tags must exist before they're pushed.
    const versionIndex = pipeline.indexOf('npx nx release version --projects=')
    const pushCallIndex = pipeline.indexOf('pushReleaseTags()')
    expect(versionIndex).toBeGreaterThan(-1)
    expect(versionIndex).toBeLessThan(pushCallIndex)
  })

  it('sets up upstream tracking before the tag push, without failing the build if it can\'t', () => {
    const pipeline = readToolchainAsset('build-templates/04-publish-libs.mjs')

    // Azure Pipelines reattaches its detached-HEAD checkout with a bare
    // `git checkout -B` (see azure-pipelines.yml), which never configures an
    // upstream — a bare `git push origin` then fails outright with "has no
    // upstream branch" even though only a tag is pushed. runSafe never
    // throws, so a branch with no matching origin ref (e.g. unpushed)
    // doesn't fail this step; the tag push further down fails there instead,
    // with a clearer error.
    expect(pipeline).toMatch(/function ensureUpstreamTracking/)
    expect(pipeline).toMatch(/git branch --set-upstream-to=origin\/\$\{branch\} \$\{branch\}/)
    expect(pipeline.indexOf('ensureUpstreamTracking(branch)')).toBeLessThan(pipeline.indexOf('npx nx release version --projects='))
  })

  it('pushes release tags itself, without --atomic, instead of using nx\'s own --git-push', () => {
    const pipeline = readToolchainAsset('build-templates/04-publish-libs.mjs')

    // nx hardcodes --atomic in its own git push implementation with no way to
    // disable it, and Azure Repos' git server has never supported atomic
    // pushes (confirmed with Microsoft — no advertised capability, no
    // server-side setting) — so nx's --git-push fails outright on every
    // Azure DevOps release with "the receiving end does not support --atomic
    // push". --follow-tags (not --tags) mirrors nx's own reasoning: push only
    // the annotated tags reachable from what's being pushed, not every tag.
    expect(pipeline).toMatch(/function pushReleaseTags/)
    // Pins down the exact command line pushReleaseTags runs — proof enough
    // it doesn't carry --atomic, without a bare /--atomic/ check that would
    // also (falsely) match this file's own explanatory comments about it.
    expect(pipeline).toMatch(/runInherit\('git push --follow-tags --no-verify origin'\)/)
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
