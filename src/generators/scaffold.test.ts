import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonSafe } from '../engine/fsx'
import type { NxMagicConfig, ProjectKind } from '../engine/types'
import { generateProject, projectFiles } from './scaffold'

const config: NxMagicConfig = {
  templateVersion: '0.1.0',
  workspaceName:   'demo',
  displayName:     'Demo',
  scope:           '@demo',
  defaultBase:     'main',
  nodeVersion:     '24',
  azure:           { organization: 'org', project: 'proj', artifactsFeed: 'feed' },
}

let repoRoot: string
let currentLogSpy: jest.SpyInstance

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'nx-magic-scaffold-'))
  currentLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

function readManifest (): Record<string, unknown> {
  return readJsonSafe<Record<string, unknown>>(join(repoRoot, 'package.json'), {})
}

describe('projectFiles', () => {
  it('delegates to the matching template for every known kind', () => {
    const kinds: ProjectKind[] = ['internal-lib', 'publishable-lib', 'cli-tool', 'function-app', 'react-app']
    for (const kind of kinds) {
      const files = projectFiles(kind, { kind, name: 'thing', packageName: '@demo/thing', scope: '@demo' })
      expect(files.length).toBeGreaterThan(0)
    }
  })

  it('throws for an unimplemented kind', () => {
    expect(() => projectFiles('unknown' as ProjectKind, { kind: 'internal-lib', name: 'x', packageName: '@demo/x', scope: '@demo' }))
      .toThrow('The \'unknown\' generator is not implemented yet.')
  })
})

describe('generateProject', () => {
  it('writes an internal-lib without touching root dependencies', () => {
    generateProject(repoRoot, 'internal-lib', 'helpers', config)
    expect(readManifest().dependencies).toBeUndefined()
  })

  it('adds only dependencies (no devDependencies) for a function-app', () => {
    generateProject(repoRoot, 'function-app', 'api', config)
    const manifest = readManifest()
    expect(manifest.dependencies).toEqual({ '@azure/functions': '^4.16.0' })
    expect(manifest.devDependencies).toBeUndefined()
    expect(currentLogSpy).toHaveBeenCalledWith(expect.stringContaining('added root dependencies: @azure/functions'))
  })

  it('adds both dependencies and devDependencies for a react-app', () => {
    generateProject(repoRoot, 'react-app', 'web', config)
    const manifest = readManifest()
    expect(manifest.dependencies).toEqual(expect.objectContaining({ react: '^19.2.0' }))
    expect(manifest.devDependencies).toEqual(expect.objectContaining({ vite: '^6.0.7' }))
  })

  it('skips the root-dependencies log line once everything is already present', () => {
    generateProject(repoRoot, 'function-app', 'api', config)
    currentLogSpy.mockClear()
    generateProject(repoRoot, 'function-app', 'api2', config)
    expect(currentLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('added root dependencies'))
  })
})
