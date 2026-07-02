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
    const detected = detectKind(directory)
    expect(detected.kind).toBe('function-app')
    expect(detected.evidence).toEqual(['has host.json', 'depends on @azure/functions'])
  })

  it('detects a react app from a react dependency', () => {
    const directory = writeProject('apps', 'web', { private: true, dependencies: { react: '^19.0.0' } })
    expect(detectKind(directory)).toEqual({ kind: 'react-app', evidence: ['depends on react'] })
  })

  it('detects a react app from a vite config plus index.html', () => {
    const directory = writeProject('apps', 'site', { private: true }, { 'vite.config.ts': '', 'index.html': '<html></html>' })
    expect(detectKind(directory)).toEqual({ kind: 'react-app', evidence: ['has a vite config and index.html'] })
  })

  it('detects a cli tool from a bin field', () => {
    const directory = writeProject('libs', 'tool', { private: true, bin: { tool: './cli.js' } })
    expect(detectKind(directory).kind).toBe('cli-tool')
  })

  it('detects a cli tool from monecromanci.dist.bin', () => {
    const directory = writeProject('libs', 'tool2', { private: true, monecromanci: { dist: { bin: { tool2: './cli.js' } } } })
    expect(detectKind(directory).kind).toBe('cli-tool')
  })

  it('detects a publishable lib from publishConfig or a non-private package', () => {
    const published = writeProject('libs', 'pub', { private: true, publishConfig: { registry: 'https://example.com' } })
    expect(detectKind(published).kind).toBe('publishable-lib')

    const nonPrivate = writeProject('libs', 'open', { name: '@demo/open' })
    expect(detectKind(nonPrivate)).toEqual({ kind: 'publishable-lib', evidence: ['is not marked private'] })
  })

  it('falls back to internal-lib for a private package with no app signals', () => {
    const directory = writeProject('libs', 'helpers', { private: true })
    expect(detectKind(directory).kind).toBe('internal-lib')
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

  it('parses Azure coordinates from .npmrc registry URLs', () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'plain' }))
    writeFileSync(join(repoRoot, '.npmrc'), '@acme:registry=https://pkgs.dev.azure.com/my-org/MyProject/_packaging/MyFeed/npm/registry/\n')

    const defaults = detectRepoDefaults(repoRoot, [])

    expect(defaults.azure).toEqual({ organization: 'my-org', project: 'MyProject', artifactsFeed: 'MyFeed' })
  })

  it('parses Azure coordinates from a project publishConfig when .npmrc has none', () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'plain' }))
    writeProject('libs', 'pub', {
      name:          '@acme/pub',
      publishConfig: { registry: 'https://pkgs.dev.azure.com/org2/Proj2/_packaging/Feed2/npm/registry/' },
    })

    const defaults = detectRepoDefaults(repoRoot, candidatesFor())

    expect(defaults.azure).toEqual({ organization: 'org2', project: 'Proj2', artifactsFeed: 'Feed2' })
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
    expect(defaults.azure).toBeUndefined()
    expect(defaults.defaultBase).toBe('main')
  })
})
