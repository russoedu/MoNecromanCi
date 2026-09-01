import { readFileSync } from 'node:fs'
import path from 'node:path'
import { recommended, rules } from './eslint-plugin.js'
import * as api from './index.js'

const README = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')

/**
 * Every name the README imports from this package, by entry point.
 *
 * @remarks
 * Parsed rather than listed, so a new example is covered the moment it is
 * written. Documentation is the one place a rename is guaranteed not to fail a
 * build, which is exactly why it needs a gate of its own.
 *
 * @param entryPoint - The specifier to collect imports for.
 * @returns The imported names.
 * @throws Never - a regex scan.
 * @typeParam None - this function has no generic type parameters.
 */
function importedFrom (entryPoint: string): string[] {
  const pattern = new RegExp(String.raw`import \{([^}]*)\} from '${entryPoint}'`, 'g')
  return README.matchAll(pattern)
    .flatMap(match =>
      (match[1] ?? '')
        .split(',')
        .map(name => name.trim())
        .filter(name => name.length > 0)
    )
    .toArray()
}

describe('README', () => {
  it('imports only names the package actually exports', () => {
    const imported = importedFrom('@mnci/az-durable')
    expect(imported.length).toBeGreaterThan(0)
    const exported = new Set(Object.keys(api))
    expect(imported.filter(name => !exported.has(name))).toEqual([])
  })

  it('documents every lint rule, and none that does not exist', () => {
    const documented = README.matchAll(/^\| `([a-z-]+)` \| (error|warn) \|/gm)
      .map(m => [m[1], m[2]])
      .toArray()
    expect(new Set(documented.map(([name]) => name))).toEqual(new Set(Object.keys(rules)))
  })

  it('documents each rule at the severity the recommended config sets', () => {
    const documented = README.matchAll(/^\| `([a-z-]+)` \| (error|warn) \|/gm).toArray()
    expect(documented.length).toBeGreaterThan(0)
    for (const match of documented) {
      const configured = recommended.rules[`az-durable/${String(match[1])}` as keyof typeof recommended.rules]
      expect([match[1], configured]).toEqual([match[1], match[2]])
    }
  })

  it('names every entry point the manifest declares', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    ) as { exports: Record<string, unknown> }
    const subpaths = Object.keys(manifest.exports)
      .filter(key => key !== '.' && key !== './package.json')
      .map(key => key.replace('./', '@mnci/az-durable/'))
    for (const subpath of subpaths) {
      expect(README).toContain(subpath)
    }
  })
})
