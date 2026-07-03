import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLegacyPeerDependencies, findSupersededDependencies, isLegacyPeerDependenciesMissing, removeSupersededDependencies } from './dependenciesHealth'
import { readJsonSafe } from './fsx'

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'monecromanci-depshealth-'))
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

function writeManifest (manifest: Record<string, unknown>): void {
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify(manifest))
}

describe('findSupersededDependencies', () => {
  it('lists superseded lint packages from both dependency sections', () => {
    writeManifest({
      dependencies:    { 'eslint-plugin-import': '^2.31.0' },
      devDependencies: { 'eslint-config-standard': '^17.1.0', eslint: '^10.6.0' },
    })

    expect(findSupersededDependencies(repoRoot)).toEqual(['eslint-config-standard', 'eslint-plugin-import'])
  })

  it('returns nothing for a clean manifest', () => {
    writeManifest({ devDependencies: { eslint: '^10.6.0' } })
    expect(findSupersededDependencies(repoRoot)).toEqual([])
  })
})

describe('removeSupersededDependencies', () => {
  it('removes only the superseded packages and keeps everything else', () => {
    writeManifest({
      devDependencies: { 'eslint-config-standard': '^17.1.0', neostandard: '^0.13.0', eslint: '^10.6.0', lodash: '^4.0.0' },
    })

    const removed = removeSupersededDependencies(repoRoot)

    expect(removed).toEqual(['eslint-config-standard', 'neostandard'])
    expect(readJsonSafe<Record<string, unknown>>(join(repoRoot, 'package.json'), {}).devDependencies)
      .toEqual({ eslint: '^10.6.0', lodash: '^4.0.0' })
  })

  it('does not rewrite the manifest when nothing is superseded', () => {
    writeManifest({ devDependencies: { eslint: '^10.6.0' } })
    const before = readFileSync(join(repoRoot, 'package.json'), 'utf8')

    expect(removeSupersededDependencies(repoRoot)).toEqual([])
    expect(readFileSync(join(repoRoot, 'package.json'), 'utf8')).toBe(before)
  })
})

describe('ensureLegacyPeerDependencies', () => {
  it('appends the setting to an existing .npmrc without touching its content', () => {
    writeFileSync(join(repoRoot, '.npmrc'), 'registry=https://registry.npmjs.org/\n')

    expect(isLegacyPeerDependenciesMissing(repoRoot)).toBe(true)
    ensureLegacyPeerDependencies(repoRoot)

    const content = readFileSync(join(repoRoot, '.npmrc'), 'utf8')
    expect(content).toContain('registry=https://registry.npmjs.org/')
    expect(content).toContain('legacy-peer-deps=true')
    expect(isLegacyPeerDependenciesMissing(repoRoot)).toBe(false)
  })

  it('creates the .npmrc when missing and is a no-op when already set', () => {
    ensureLegacyPeerDependencies(repoRoot)
    const written = readFileSync(join(repoRoot, '.npmrc'), 'utf8')

    ensureLegacyPeerDependencies(repoRoot)
    expect(readFileSync(join(repoRoot, '.npmrc'), 'utf8')).toBe(written)
  })

  it('handles an existing .npmrc without a trailing newline', () => {
    writeFileSync(join(repoRoot, '.npmrc'), 'save-exact=true')

    ensureLegacyPeerDependencies(repoRoot)

    const lines = readFileSync(join(repoRoot, '.npmrc'), 'utf8').split('\n')
    expect(lines[0]).toBe('save-exact=true')
    expect(lines).toContain('legacy-peer-deps=true')
  })
})
