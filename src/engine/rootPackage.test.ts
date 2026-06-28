import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonSafe } from './fsx'
import { addRootDependencies } from './rootPackage'

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'nx-magic-rootpkg-'))
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
