import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TAGS } from './constants'
import { discoverProjects } from './projects'
import type { MonecromanciConfig } from './types'

const config: MonecromanciConfig = {
  templateVersion: '0.1.0',
  workspaceName:   'demo',
  displayName:     'Demo',
  scope:           '@demo',
  defaultBase:     'main',
  nodeVersion:     '24',
  azure:           { organization: 'org', project: 'proj', artifactsFeed: 'feed' },
}

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'monecromanci-projects-'))
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

function writeProject (
  area: 'apps' | 'libs',
  name: string,
  projectJson: Record<string, unknown> | undefined,
  packageJson: Record<string, unknown> | undefined,
): void {
  const directory = join(repoRoot, area, name)
  mkdirSync(directory, { recursive: true })
  if (projectJson) {
    writeFileSync(join(directory, 'project.json'), JSON.stringify(projectJson))
  }
  if (packageJson) {
    writeFileSync(join(directory, 'package.json'), JSON.stringify(packageJson))
  }
}

describe('discoverProjects', () => {
  it('returns nothing when apps/ and libs/ do not exist', () => {
    expect(discoverProjects(repoRoot, config)).toEqual([])
  })

  it('skips non-directory entries inside an area', () => {
    mkdirSync(join(repoRoot, 'apps'), { recursive: true })
    writeFileSync(join(repoRoot, 'apps', 'README.md'), 'not a project')
    expect(discoverProjects(repoRoot, config)).toEqual([])
  })

  it('skips a project directory with no recognisable tags', () => {
    writeProject('apps', 'untagged', { tags: ['ci:ignore'] }, {})
    expect(discoverProjects(repoRoot, config)).toEqual([])
  })

  it('skips a project directory missing both project.json and package.json', () => {
    mkdirSync(join(repoRoot, 'apps', 'empty'), { recursive: true })
    expect(discoverProjects(repoRoot, config)).toEqual([])
  })

  it('identifies a function-app', () => {
    writeProject('apps', 'api', { tags: [TAGS.functionApp] }, { name: '@demo/api' })
    expect(discoverProjects(repoRoot, config)).toEqual([
      { kind: 'function-app', name: 'api', packageName: '@demo/api', scope: '@demo', azure: config.azure },
    ])
  })

  it('identifies a react-app', () => {
    writeProject('apps', 'web', { tags: [TAGS.reactApp] }, { name: '@demo/web' })
    expect(discoverProjects(repoRoot, config)[0].kind).toBe('react-app')
  })

  it('identifies an internal-lib', () => {
    writeProject('libs', 'helpers', { tags: [TAGS.internalLib] }, { name: '@demo/helpers' })
    expect(discoverProjects(repoRoot, config)[0].kind).toBe('internal-lib')
  })

  it('identifies a publishable-lib without a bin', () => {
    writeProject('libs', 'sdk', { tags: [TAGS.publishableLib] }, { name: '@demo/sdk' })
    expect(discoverProjects(repoRoot, config)[0].kind).toBe('publishable-lib')
  })

  it('identifies a cli-tool via a top-level bin field', () => {
    writeProject('libs', 'mytool', { tags: [TAGS.publishableLib] }, { name: '@demo/mytool', bin: { mytool: './dist/cli.js' } })
    expect(discoverProjects(repoRoot, config)[0].kind).toBe('cli-tool')
  })

  it('identifies a cli-tool via monecromanci.dist.bin when no top-level bin is set', () => {
    writeProject('libs', 'mytool', { tags: [TAGS.publishableLib] }, { name: '@demo/mytool', monecromanci: { dist: { bin: { mytool: './cli.js' } } } })
    expect(discoverProjects(repoRoot, config)[0].kind).toBe('cli-tool')
  })

  it('falls back to scope/name when package.json has no name field', () => {
    writeProject('libs', 'helpers', { tags: [TAGS.internalLib] }, {})
    expect(discoverProjects(repoRoot, config)[0].packageName).toBe('@demo/helpers')
  })

  it('treats a missing project.json as having no tags', () => {
    mkdirSync(join(repoRoot, 'libs', 'orphan'), { recursive: true })
    writeFileSync(join(repoRoot, 'libs', 'orphan', 'package.json'), JSON.stringify({ name: '@demo/orphan' }))
    expect(discoverProjects(repoRoot, config)).toEqual([])
  })
})
