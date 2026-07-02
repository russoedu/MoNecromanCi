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
  workspaceName: 'demo',
  displayName:   'Demo',
  scope:         '@demo',
  defaultBase:   'main',
  nodeVersion:   '24',
  ci:            'azure',
  registry:      { kind: 'azure-artifacts', organization: 'org', project: 'Automation', artifactsFeed: 'FEED' },
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
    expect(hasPath('jest.preset.mjs')).toBe(true)
    expect(hasPath('Demo.code-workspace')).toBe(true)
    expect(hasPath('azure-pipelines.yml')).toBe(true)
    expect(hasPath('.build-templates/03-package-apps.mjs')).toBe(true)
    expect(hasPath('docs/nx-release.md')).toBe(true)
  })

  it('enables source maps in the jest tsconfig (debug requirement)', () => {
    const tsconfig = readJson<{ compilerOptions: { sourceMap: boolean } }>('tsconfig.jest.json')
    expect(tsconfig.compilerOptions.sourceMap).toBe(true)
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
