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

describe('nonJs(), the hybrid half for oxlint workspaces', () => {
  /**
   * Resolves a composed config in a subprocess and reports its block names.
   *
   * @param expression - A call expression against the package's exports.
   * @returns The `name` of every block, in composition order.
   */
  function namesOf(expression: string): string[] {
    const script = `
      const mnci = await import(${JSON.stringify(join(packageRoot, 'index.js'))})
      const blocks = ${expression}
      process.stdout.write(JSON.stringify(blocks.map(b => b.name ?? null)))
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8'
    })
    if (!result.stdout?.trim().startsWith('[')) {
      throw new Error(`could not resolve: ${result.stderr}`)
    }
    return JSON.parse(result.stdout.trim()) as string[]
  }

  const hybrid = namesOf(`mnci.nonJs({ workspaceRoot: ${JSON.stringify(packageRoot)} })`)

  it('covers every language oxlint cannot parse', () => {
    // The reason this export exists. oxlint reads JS/TS/JSX/Vue only, so without
    // these a workspace that picked oxlint would lint its CI YAML, its
    // pyproject.toml and its publishable manifests with nothing at all.
    for (const block of [
      'mnci/json',
      'mnci/jsonc',
      'mnci/json5',
      'mnci/markdown',
      'mnci/css',
      'mnci/html'
    ]) {
      expect(hybrid).toContain(block)
    }
    expect(hybrid.some(name => name.startsWith('mnci/yaml'))).toBe(true)
    expect(hybrid.some(name => name.startsWith('mnci/toml'))).toBe(true)
  })

  it('keeps @nx/dependency-checks, which is the one oxlint has no answer for', () => {
    expect(hybrid).toContain('mnci/nx-dependency-checks')
  })

  it('omits every JS/TS block, so oxlint is not double-reported', () => {
    // The failure this prevents is not a crash but a duplicate: one defect
    // reported twice, once by oxlint and once by ESLint, under two rule names.
    for (const block of [
      'mnci/base',
      'mnci/typescript',
      'mnci/type-aware',
      'mnci/react',
      'mnci/tests'
    ]) {
      expect(hybrid).not.toContain(block)
    }
    expect(hybrid.some(name => name.startsWith('typescript-eslint/'))).toBe(false)
    expect(hybrid.some(name => name.startsWith('mnci/regexp'))).toBe(false)
  })

  it('omits the Prettier-reconciliation blocks, since oxfmt formats instead', () => {
    expect(hybrid).not.toContain('mnci/prettier-compat')
    expect(hybrid).not.toContain('mnci/stylistic')
  })

  it('is a strict subset of the full config, never a parallel copy', () => {
    // Guards the thing that would rot: someone adding a block here that mnci()
    // does not have, so the two modes diverge on the same file type.
    const full = namesOf(`mnci.default({ workspaceRoot: ${JSON.stringify(packageRoot)} })`)
    expect(hybrid.filter(name => !full.includes(name))).toEqual([])
  })

  it('still names every block', () => {
    expect(hybrid.filter(name => name === null)).toEqual([])
  })
})
