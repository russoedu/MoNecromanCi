import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * Every block in the resolved config must carry a unique `name`.
 *
 * @remarks
 * A name is not decoration here. An mnci workspace's root `eslint.config.mjs` is
 * three lines long, and the blocks behind it — currently 29 of them — live in
 * this package. When someone needs to know which block turned a rule on, or
 * which one to override, `eslint --inspect-config` is the tool and the block's
 * `name` is the only handle it offers. An anonymous block is listed by index,
 * and an index moves whenever a block is added above it.
 *
 * So this asserts the property rather than the current list: a new block shipped
 * without a name fails here, which is the only point at which it is cheap to
 * fix. Uniqueness matters for the same reason — two blocks sharing a name send
 * the reader to the wrong one.
 *
 * A subprocess, because this package is ESM and these specs run as CJS under
 * ts-jest — see `config.spec.ts`.
 */

const packageRoot = join(__dirname, '..')

/**
 * Resolves the config in a Node subprocess and reports each block's name.
 *
 * @returns One entry per block, in composition order; `null` where a block has
 * no name.
 * @throws If the subprocess fails or writes no JSON.
 */
function blockNames(): (string | null)[] {
  const script = `
    const mnci = (await import(${JSON.stringify(join(packageRoot, 'index.js'))})).default
    const blocks = mnci({ workspaceRoot: ${JSON.stringify(packageRoot)} })
    process.stdout.write(JSON.stringify(blocks.map(block => block.name ?? null)))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8'
  })
  const stdout = result.stdout?.trim()
  if (!stdout?.startsWith('[')) {
    throw new Error(
      `could not resolve the config.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    )
  }
  return JSON.parse(stdout) as (string | null)[]
}

const names = blockNames()

describe('config block names', () => {
  it('composed a non-trivial number of blocks', () => {
    // Guards the two assertions below against passing on an empty array.
    expect(names.length).toBeGreaterThan(20)
  })

  it('names every block, including the ones spread from a preset', () => {
    // The presets are where this breaks: `eslint-plugin-yml`, `eslint-plugin-toml`
    // and `eslint-config-prettier` all ship unnamed blocks, so spreading one
    // directly puts an anonymous entry in a consumer's resolved config.
    // `configs/named.js` exists for exactly that, and this is what says so.
    expect(names.filter(name => name === null)).toEqual([])
  })

  it('gives each block a distinct name', () => {
    expect(new Set(names).size).toBe(names.length)
  })

  it('namespaces its own blocks under `mnci/`, and leaves upstream names alone', () => {
    // typescript-eslint names its own blocks (`typescript-eslint/recommended`
    // and friends). Renaming those would hide where a rule actually came from,
    // so `named()` fills a name in rather than replacing one.
    expect(names).toContain('typescript-eslint/recommended')
    const own = names.filter(name => name?.startsWith('mnci/'))
    expect(own.length).toBeGreaterThan(names.length / 2)
  })
})

describe('ignore list', () => {
  it('ignores build-artifact directories, tmp included', () => {
    // `tmp` is the one that bit: `@nx/esbuild` writes intermediates there, and the
    // generated ROOT lint target has no project directory to scope it away, so a
    // freshly generated workspace failed `nx run-many -t lint` with 39 errors on
    // code the user never wrote. `.prettierignore` had always listed `tmp`, which
    // is precisely why the asymmetry went unnoticed — the formatter skipped those
    // files and the linter did not.
    //
    // Caught by the real Windows e2e, not by any fixture, because it needs a
    // workspace that has actually BUILT something.
    const script = `
      const mnci = await import(${JSON.stringify(join(packageRoot, 'index.js'))})
      process.stdout.write(JSON.stringify(mnci.ignores))
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8'
    })
    const ignores = JSON.parse(result.stdout.trim()) as string[]
    for (const artifact of ['**/tmp', '**/dist', '**/out-tsc', '**/coverage', '**/node_modules']) {
      expect(ignores).toContain(artifact)
    }
  })
})
