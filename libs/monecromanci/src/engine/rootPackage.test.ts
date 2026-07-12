import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonSafe } from './fsx'
import { addRootDependencies, mergeManifest, setRootDependencies } from './rootPackage'
import { logger } from '../util/logger'

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'monecromanci-rootpkg-'))
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

function readManifest (): Record<string, unknown> {
  return readJsonSafe<Record<string, unknown>>(join(repoRoot, 'package.json'), {})
}

describe('addRootDependencies', () => {
  it('creates a sorted dependencies section when package.json does not exist yet', () => {
    const added = addRootDependencies(repoRoot, { zeta: '^1.0.0', alpha: '^2.0.0' })
    expect(added).toEqual(['zeta', 'alpha'])
    expect(readManifest().dependencies).toEqual({ alpha: '^2.0.0', zeta: '^1.0.0' })
  })

  it('defaults to the dependencies section', () => {
    addRootDependencies(repoRoot, { foo: '^1.0.0' })
    expect(readManifest().dependencies).toEqual({ foo: '^1.0.0' })
    expect(readManifest().devDependencies).toBeUndefined()
  })

  it('targets devDependencies when asked', () => {
    addRootDependencies(repoRoot, { vite: '^6.0.0' }, 'devDependencies')
    expect(readManifest().devDependencies).toEqual({ vite: '^6.0.0' })
  })

  it('leaves an already-present dependency untouched and only reports new names as added', () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ dependencies: { foo: '^1.0.0' } }))
    const added = addRootDependencies(repoRoot, { foo: '^9.9.9', bar: '^1.0.0' })
    expect(added).toEqual(['bar'])
    expect(readManifest().dependencies).toEqual({ bar: '^1.0.0', foo: '^1.0.0' })
  })
})

describe('setRootDependencies', () => {
  it('overwrites differing versions and reports both added and changed names', () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ devDependencies: { eslint: '^8.0.0', jest: '^30.4.2' } }))
    const touched = setRootDependencies(repoRoot, { eslint: '^10.6.0', jest: '^30.4.2', 'ts-jest': '^29.4.11' }, 'devDependencies')
    expect(touched).toEqual(['eslint', 'ts-jest'])
    expect(readManifest().devDependencies).toEqual({ eslint: '^10.6.0', jest: '^30.4.2', 'ts-jest': '^29.4.11' })
  })

  it('leaves unlisted dependencies untouched', () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ devDependencies: { lodash: '^4.0.0' } }))
    setRootDependencies(repoRoot, { eslint: '^10.6.0' }, 'devDependencies')
    expect(readManifest().devDependencies).toEqual({ eslint: '^10.6.0', lodash: '^4.0.0' })
  })
})

describe('mergeManifest', () => {
  it('adds missing scripts, unions workspaces, and sets absent engines', () => {
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
      scripts:    { test: 'vitest' },
      workspaces: ['packages/*'],
    }))

    const result = mergeManifest(repoRoot, {
      scripts:    { test: 'nx run-many -t test --all', lint: 'nx run-many -t lint --all' },
      workspaces: ['apps/*', 'libs/*'],
      engines:    { node: '>=24' },
    })

    expect(result.added).toEqual(['scripts.lint', 'workspaces.apps/*', 'workspaces.libs/*', 'engines.node'])
    // The fixture's `test` script ('vitest') legitimately differs from the
    // template's ('nx run-many -t test --all') — flagged as drift, not added.
    expect(result.drifted).toEqual(['scripts.test'])
    const manifest = readManifest()
    expect(manifest.scripts).toEqual({ test: 'vitest', lint: 'nx run-many -t lint --all' })
    expect(manifest.workspaces).toEqual(['packages/*', 'apps/*', 'libs/*'])
    expect(manifest.engines).toEqual({ node: '>=24' })
  })

  it('warns about drifted scripts and never overwrites existing engines', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation()
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
      scripts: { lint: 'eslint src' },
      engines: { node: '>=18' },
    }))

    const result = mergeManifest(repoRoot, { scripts: { lint: 'nx run-many -t lint --all' }, engines: { node: '>=24' } })

    expect(result.added).toEqual([])
    expect(result.drifted).toEqual(['scripts.lint'])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('script \'lint\' differs'))
    const manifest = readManifest()
    expect(manifest.scripts).toEqual({ lint: 'eslint src' })
    expect(manifest.engines).toEqual({ node: '>=18' })
  })

  it('creates sections from scratch on an empty manifest', () => {
    writeFileSync(join(repoRoot, 'package.json'), '{}')
    const result = mergeManifest(repoRoot, { scripts: { build: 'tsc' }, workspaces: ['apps/*'] })
    expect(result.added).toEqual(['scripts.build', 'workspaces.apps/*'])
    expect(readManifest().scripts).toEqual({ build: 'tsc' })
    expect(readManifest().workspaces).toEqual(['apps/*'])
  })

  it('does not write the file in dryRun mode, but still reports what would change', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation()
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint src' } }))

    const result = mergeManifest(repoRoot, { scripts: { lint: 'nx run-many -t lint --all', build: 'tsc' } }, { dryRun: true })

    expect(result.added).toEqual(['scripts.build'])
    expect(result.drifted).toEqual(['scripts.lint'])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('script \'lint\' differs'))
    // Unwritten: the file on disk still has only the original script.
    expect(readManifest().scripts).toEqual({ lint: 'eslint src' })
  })
})
