import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every path in `generators.json`/`executors.json` must resolve to a real
 * built file.
 *
 * @remarks
 * Nx loads a generator or executor by the path string in those manifests, so
 * a directory rename that does not update them breaks the plugin **at
 * runtime, for users only**. Nothing else here would notice: every unit test
 * imports its generator through a relative TypeScript import, which keeps
 * resolving perfectly while the published manifest points at nothing.
 *
 * Written when `generators/internalLibrary` became
 * `generators/internal-library` — a rename with exactly that shape. It
 * immediately earned its keep twice over, catching that `tsc` leaves the
 * pre-rename directory behind in `dist/` (so the stale path still resolved,
 * and would have shipped), and then that cleaning `dist` without also
 * dropping the `composite: true` build info makes `tsc` skip emit entirely
 * and produce a silently empty build.
 *
 * Skips the path assertions when `dist/` has not been built, so it checks the
 * real artifact rather than failing a fresh clone.
 */

const packageRoot = join(__dirname, '..')

interface Entry { factory?: string; implementation?: string; schema?: string }

/** Every declared path in one manifest, flattened to `[label, path]`. */
function declaredPaths (manifest: string): [string, string][] {
  const file = join(packageRoot, manifest)
  if (!existsSync(file)) {
    return []
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>

  return Object.entries(parsed)
    .filter(([key]) => !key.startsWith('$'))
    .flatMap(([, group]) => Object.entries(group as Record<string, Entry>))
    .flatMap(([name, entry]) =>
      (['factory', 'implementation', 'schema'] as const).flatMap((key): [string, string][] => {
        const declared = entry[key]

        return declared === undefined ? [] : [[`${manifest} ${name}.${key}`, declared]]
      }),
    )
}

const all = [...declaredPaths('generators.json'), ...declaredPaths('executors.json')]
const built = existsSync(join(packageRoot, 'dist'))

describe('the Nx plugin manifests point at files that exist', () => {
  it('declares at least one generator or executor', () => {
    expect(all.length).toBeGreaterThan(0)
  })

  const check = built ? it : it.skip
  check.each(all)('%s resolves to a built file (%s)', (_label, declared) => {
    const target = join(packageRoot, declared)
    const found = [target, `${target}.js`, `${target}.json`].some(candidate =>
      existsSync(candidate),
    )

    expect(found).toBe(true)
  })
})
