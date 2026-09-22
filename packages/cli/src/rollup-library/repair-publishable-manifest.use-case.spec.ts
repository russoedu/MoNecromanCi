import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repairPublishableManifests } from './repair-publishable-manifest.use-case'

let workspaceRoot: string

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-manifest-repair-'))
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@demo/source' }))
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('repairPublishableManifests', () => {
  it('repoints a stale types path in every packages/*/libs/* manifest, and reports what changed', () => {
    mkdirSync(join(workspaceRoot, 'packages/align'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'libs/design'), { recursive: true })
    const staleManifest = JSON.stringify({
      name:    '@demo/align',
      types:   './dist/index.esm.d.ts',
      exports: { '.': { types: './dist/index.esm.d.ts' } },
      files:   ['dist'],
    })
    writeFileSync(join(workspaceRoot, 'packages/align/package.json'), staleManifest)
    // Already correct, and written in mnci's own toJson format (2-space,
    // trailing newline) — the realistic shape of a manifest nothing is
    // wrong with, so the sweep must round-trip it byte-identical and not
    // report it as changed.
    writeFileSync(
      join(workspaceRoot, 'libs/design/package.json'),
      `${JSON.stringify({ name: '@demo/design', types: './dist/src/index.d.ts' }, undefined, 2)}\n`,
    )

    const changed = repairPublishableManifests(workspaceRoot)

    expect(changed).toEqual(['packages/align/package.json'])
    const repaired = JSON.parse(
      readFileSync(join(workspaceRoot, 'packages/align/package.json'), 'utf8'),
    ) as { types: string; exports: { '.': { types: string } } }
    expect(repaired.types).toBe('./dist/src/index.d.ts')
    expect(repaired.exports['.'].types).toBe('./dist/src/index.d.ts')
  })

  it('reports nothing changed on a repeat run', () => {
    mkdirSync(join(workspaceRoot, 'packages/align'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'packages/align/package.json'),
      JSON.stringify({ name: '@demo/align', types: './dist/index.esm.d.ts' }),
    )
    repairPublishableManifests(workspaceRoot)

    expect(repairPublishableManifests(workspaceRoot)).toEqual([])
  })
})
