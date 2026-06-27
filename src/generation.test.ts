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
  displayName: 'Demo',
  scope: '@demo',
  defaultBase: 'main',
  nodeVersion: '24',
  azure: { organization: 'org', project: 'Automation', artifactsFeed: 'FEED' },
}

let repo: string

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'nx-magic-'))
  applyFiles(repo, monorepoFiles(vars))
  saveConfig(repo, configFromVars(vars))

  const config = configFromVars(vars)
  generateProject(repo, 'internal-lib', 'helpers', config)
  generateProject(repo, 'publishable-lib', 'sdk', config)
  generateProject(repo, 'cli-tool', 'mytool', config)
  generateProject(repo, 'function-app', 'api', config)
  generateProject(repo, 'react-app', 'web', config)
})

afterAll(() => {
  if (repo) {
    rmSync(repo, { recursive: true, force: true })
  }
})

const read = (path: string): string => readFileSync(join(repo, path), 'utf8')
const exists = (path: string): boolean => existsSync(join(repo, path))
function readJson<T> (path: string): T {
  return JSON.parse(read(path)) as T
}

describe('monorepo scaffolding', () => {
  it('writes the central configs and vendored pipeline', () => {
    expect(exists('nx.json')).toBe(true)
    expect(exists('eslint.config.mjs')).toBe(true)
    expect(exists('jest.preset.mjs')).toBe(true)
    expect(exists('Demo.code-workspace')).toBe(true)
    expect(exists('azure-pipelines.yml')).toBe(true)
    expect(exists('.build-templates/03-package-apps.mjs')).toBe(true)
    expect(exists('docs/nx-release.md')).toBe(true)
  })

  it('enables source maps in the jest tsconfig (debug requirement)', () => {
    const tsconfig = readJson<{ compilerOptions: { sourceMap: boolean } }>('tsconfig.jest.json')
    expect(tsconfig.compilerOptions.sourceMap).toBe(true)
  })

  it('places launch at the workspace top level with a breakpoint-capable jest config', () => {
    const workspace = readJson<{
      launch?: { configurations: Array<Record<string, unknown>> }
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
    const pkg = readJson<{ main: string }>('libs/helpers/package.json')
    expect(pkg.main).toBe('./src/index.ts')
    const project = readJson<{ tags: string[] }>('libs/helpers/project.json')
    expect(project.tags).toContain('type:internal-lib')
  })

  it('ships function-app configurations, clean:config and a root @azure/functions dep', () => {
    expect(exists('apps/api/.configurations/dev.json')).toBe(true)
    expect(exists('apps/api/.configurations/uat.json')).toBe(true)
    expect(exists('apps/api/.configurations/prod.json')).toBe(true)
    expect(exists('tools/clean-config.mjs')).toBe(true)
    const root = readJson<{ dependencies: Record<string, string> }>('package.json')
    expect(root.dependencies['@azure/functions']).toBeDefined()
  })

  it('gives the react app multi-env builds and adds react deps to the root', () => {
    const pkg = readJson<{ scripts: Record<string, string> }>('apps/web/package.json')
    expect(pkg.scripts['build:all']).toContain('build:uat')
    expect(exists('apps/web/.env.uat')).toBe(true)
    const root = readJson<{ dependencies: Record<string, string>, devDependencies: Record<string, string> }>('package.json')
    expect(root.dependencies.react).toBeDefined()
    expect(root.devDependencies.vite).toBeDefined()
  })

  it('marks a cli tool with a bin and the resolved-deps script', () => {
    const pkg = readJson<{ bin: Record<string, string> }>('libs/mytool/package.json')
    expect(pkg.bin.mytool).toBe('./dist/cli.js')
    expect(exists('tools/generate-dist-package.mjs')).toBe(true)
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
