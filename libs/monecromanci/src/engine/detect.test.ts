import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TAGS } from './constants'
import { detectKind, detectRepoDefaults, findCandidates } from './detect'
import type { CandidateProject } from './detect'

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'monecromanci-detect-'))
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

function writeProject (area: 'apps' | 'libs', name: string, packageJson: Record<string, unknown>, extraFiles: Record<string, string> = {}): string {
  const directory = join(repoRoot, area, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify(packageJson))
  for (const [file, content] of Object.entries(extraFiles)) {
    writeFileSync(join(directory, file), content)
  }
  return directory
}

describe('detectKind', () => {
  it('detects a function app from host.json and @azure/functions', () => {
    const directory = writeProject('apps', 'func', { private: true, dependencies: { '@azure/functions': '^4.0.0' } }, { 'host.json': '{}' })
    const detected = detectKind(directory, 'apps')
    expect(detected.kind).toBe('function-app')
    expect(detected.evidence).toEqual(['has host.json', 'depends on @azure/functions'])
  })

  it('detects a nextjs app before react (next apps depend on react too)', () => {
    const directory = writeProject('apps', 'full', { private: true, dependencies: { next: '^15.0.0', react: '^19.0.0' } })
    expect(detectKind(directory, 'apps')).toEqual({ kind: 'nextjs-app', evidence: ['depends on next'] })
  })

  it('detects vue and svelte apps from their framework dependency', () => {
    const vue = writeProject('apps', 'vueapp', { private: true, dependencies: { vue: '^3.5.0' } })
    expect(detectKind(vue, 'apps').kind).toBe('vue-app')

    const svelte = writeProject('apps', 'svapp', { private: true, devDependencies: { svelte: '^5.0.0' } })
    expect(detectKind(svelte, 'apps').kind).toBe('svelte-app')
  })

  it('detects a react app from a react dependency', () => {
    const directory = writeProject('apps', 'web', { private: true, dependencies: { react: '^19.0.0' } })
    expect(detectKind(directory, 'apps')).toEqual({ kind: 'react-app', evidence: ['depends on react'] })
  })

  it('detects a react app from a vite config plus index.html', () => {
    const directory = writeProject('apps', 'site', { private: true }, { 'vite.config.ts': '', 'index.html': '<html></html>' })
    expect(detectKind(directory, 'apps')).toEqual({ kind: 'react-app', evidence: ['has a vite config and index.html'] })
  })

  it('falls back to node-app for an apps/ project with no frontend signals', () => {
    const directory = writeProject('apps', 'server', { private: true, dependencies: { express: '^5.0.0' } })
    expect(detectKind(directory, 'apps').kind).toBe('node-app')
  })

  it('detects a cli tool from a bin field', () => {
    const directory = writeProject('libs', 'tool', { private: true, bin: { tool: './cli.js' } })
    expect(detectKind(directory, 'libs').kind).toBe('cli-tool')
  })

  it('detects a cli tool from monecromanci.dist.bin', () => {
    const directory = writeProject('libs', 'tool2', { private: true, monecromanci: { dist: { bin: { tool2: './cli.js' } } } })
    expect(detectKind(directory, 'libs').kind).toBe('cli-tool')
  })

  it('detects a publishable lib from publishConfig or a non-private package', () => {
    const published = writeProject('libs', 'pub', { private: true, publishConfig: { registry: 'https://example.com' } })
    expect(detectKind(published, 'libs').kind).toBe('publishable-lib')

    const nonPrivate = writeProject('libs', 'open', { name: '@demo/open' })
    expect(detectKind(nonPrivate, 'libs')).toEqual({ kind: 'publishable-lib', evidence: ['is not marked private'] })
  })

  it('falls back to internal-lib for a private package with no app signals', () => {
    const directory = writeProject('libs', 'helpers', { private: true })
    expect(detectKind(directory, 'libs').kind).toBe('internal-lib')
  })
})

describe('findCandidates', () => {
  it('collects unmanaged apps/libs projects and skips already-managed ones', () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'libs/*'] }))
    writeProject('apps', 'func', { name: '@demo/func', private: true }, { 'host.json': '{}' })
    const managedDirectory = writeProject('libs', 'done', { name: '@demo/done', private: true })
    writeFileSync(join(managedDirectory, 'project.json'), JSON.stringify({ tags: [TAGS.internalLib] }))
    mkdirSync(join(repoRoot, 'libs', 'no-package'), { recursive: true })

    const scan = findCandidates(repoRoot)

    expect(scan.candidates.map((candidate) => candidate.path)).toEqual(['apps/func'])
    expect(scan.candidates[0]).toMatchObject({ area: 'apps', name: 'func', packageName: '@demo/func', detected: { kind: 'function-app' } })
    expect(scan.managed).toEqual(['libs/done'])
    expect(scan.outside).toEqual([])
  })

  it('reports workspace globs outside apps//libs/ with their matching directories', () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*', 'tools/misc'] }))
    mkdirSync(join(repoRoot, 'packages', 'legacy'), { recursive: true })
    writeFileSync(join(repoRoot, 'packages', 'legacy', 'package.json'), '{}')

    const scan = findCandidates(repoRoot)

    expect(scan.outside).toEqual(['packages/legacy', 'tools/misc'])
  })

  it('reports the bare glob when its directory does not exist or is empty', () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
    expect(findCandidates(repoRoot).outside).toEqual(['packages/*'])
  })
})

describe('detectRepoDefaults', () => {
  const candidatesFor = (): CandidateProject[] => findCandidates(repoRoot).candidates

  it('derives names, scope, and node version from the manifests', () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: '@acme/legacy-repo', engines: { node: '>=22' } }))
    writeProject('libs', 'one', { name: '@acme/one', private: true })
    writeProject('libs', 'two', { name: '@acme/two', private: true })
    writeProject('libs', 'other', { name: '@other/three', private: true })

    const defaults = detectRepoDefaults(repoRoot, candidatesFor())

    expect(defaults.workspaceName).toBe('legacy-repo')
    expect(defaults.displayName).toBe('legacy-repo')
    expect(defaults.scope).toBe('@acme')
    expect(defaults.nodeVersion).toBe('22')
    expect(defaults.defaultBase).toBe('main')
  })

  it('parses an Azure Artifacts registry from .npmrc registry URLs', () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'plain' }))
    writeFileSync(join(repoRoot, '.npmrc'), '@acme:registry=https://pkgs.dev.azure.com/my-org/MyProject/_packaging/MyFeed/npm/registry/\n')

    const defaults = detectRepoDefaults(repoRoot, [])

    expect(defaults.registry).toEqual({ kind: 'azure-artifacts', organization: 'my-org', project: 'MyProject', artifactsFeed: 'MyFeed' })
  })

  it('parses an Azure Artifacts registry from a project publishConfig when .npmrc has none', () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'plain' }))
    writeProject('libs', 'pub', {
      name:          '@acme/pub',
      publishConfig: { registry: 'https://pkgs.dev.azure.com/org2/Proj2/_packaging/Feed2/npm/registry/' },
    })

    const defaults = detectRepoDefaults(repoRoot, candidatesFor())

    expect(defaults.registry).toEqual({ kind: 'azure-artifacts', organization: 'org2', project: 'Proj2', artifactsFeed: 'Feed2' })
  })

  it('detects a GitHub Packages registry and derives the owner from the scope', () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: '@acme/legacy' }))
    writeFileSync(join(repoRoot, '.npmrc'), '@acme:registry=https://npm.pkg.github.com/\n')

    const defaults = detectRepoDefaults(repoRoot, [])

    expect(defaults.registry).toEqual({ kind: 'github-packages', owner: 'acme' })
  })

  it('infers the CI provider from existing CI files', () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'plain' }))
    expect(detectRepoDefaults(repoRoot, []).ci).toBeUndefined()

    writeFileSync(join(repoRoot, 'azure-pipelines.yml'), '')
    expect(detectRepoDefaults(repoRoot, []).ci).toBe('azure')

    mkdirSync(join(repoRoot, '.github', 'workflows'), { recursive: true })
    expect(detectRepoDefaults(repoRoot, []).ci).toBe('both')

    rmSync(join(repoRoot, 'azure-pipelines.yml'))
    expect(detectRepoDefaults(repoRoot, []).ci).toBe('github')
  })

  it('reads the default branch from git origin/HEAD when available', () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'plain' }))
    execSync('git init --quiet', { cwd: repoRoot })
    execSync('git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop', { cwd: repoRoot })

    expect(detectRepoDefaults(repoRoot, []).defaultBase).toBe('develop')
  })

  it('returns no optional defaults for a bare repo', () => {
    writeFileSync(join(repoRoot, 'package.json'), '{}')

    const defaults = detectRepoDefaults(repoRoot, [])

    expect(defaults.workspaceName).toBeUndefined()
    expect(defaults.scope).toBeUndefined()
    expect(defaults.nodeVersion).toBeUndefined()
    expect(defaults.registry).toBeUndefined()
    expect(defaults.defaultBase).toBe('main')
  })
})
