import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The formatting half, tested the way the sibling package tests Prettier: by
 * running the real binary against fixtures.
 *
 * @remarks
 * Two distinct claims are made here and they need different tests.
 *
 * 1. **oxfmt applies JavaScript Standard Style** — the options are not silently
 *    ignored. Same trap as Prettier's config precedence: a formatter that finds
 *    a config and disregards it looks identical to one that has no config.
 * 2. **oxfmt agrees with Prettier**, which is the claim that justifies swapping
 *    them at all. Asserted by formatting the same input with both binaries and
 *    diffing the results, rather than by trusting that identically-named options
 *    mean identical behaviour.
 *
 * The second is the one that will break first: oxfmt is pre-1.0. When it does
 * break, the failure names the construct, which is what makes it actionable.
 */

const packageRoot = join(__dirname, '..')
const bin = (name: string): string => join(packageRoot, '..', '..', 'node_modules', '.bin', name)

/** Standard-style inputs, and what both formatters should make of them. */
const CASES: Record<string, { input: string; expected: string }> = {
  'quotes.ts': {
    input: 'export const a = "double";\n',
    expected: "export const a = 'double'\n"
  },
  'commas.ts': {
    input: 'export const o = {\n  a: 1,\n  b: 2,\n}\n',
    expected: 'export const o = {\n  a: 1,\n  b: 2\n}\n'
  },
  'arrow.ts': {
    input: 'export const f = (x) => x\n',
    expected: 'export const f = x => x\n'
  }
}

let workspace: string

/**
 * Formats one fixture with the given binary, resolving config from disk.
 *
 * @param tool - `oxfmt` or `prettier`.
 * @param filename - Fixture to write and format.
 * @param contents - Fixture contents.
 * @returns The formatted file contents.
 * @throws If the formatter exits non-zero.
 */
function format(tool: 'oxfmt' | 'prettier', filename: string, contents: string): string {
  const target = join(workspace, `${tool}-${filename}`)
  writeFileSync(target, contents)
  const args = tool === 'oxfmt' ? [target] : ['--write', target]
  const result = spawnSync(bin(tool), args, {
    cwd: workspace,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) {
    throw new Error(`${tool} failed on ${filename}: ${result.stderr}`)
  }
  return readFileSync(target, 'utf8')
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'mnci-oxfmt-'))
  const oxfmtModule = await import(join(packageRoot, 'oxfmt.js'))
  const options = oxfmtModule.default as Record<string, unknown>

  // Both formatters read their own config file, so the assertion covers config
  // resolution and not just the option values.
  writeFileSync(join(workspace, '.oxfmtrc.json'), JSON.stringify(options))
  writeFileSync(join(workspace, '.prettierrc.json'), JSON.stringify(options))
  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ name: 'probe', private: true, type: 'module' })
  )
})

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('@mnci/oxlint-config/oxfmt', () => {
  it.each(Object.entries(CASES))('applies Standard style to %s', (name, { input, expected }) => {
    expect(format('oxfmt', name, input)).toBe(expected)
  })

  it.each(Object.entries(CASES))('agrees with Prettier on %s', (name, { input }) => {
    // The claim that makes the swap defensible. If this fails, oxfmt has drifted
    // and the divergence is whatever this fixture exercises.
    expect(format('oxfmt', name, input)).toBe(format('prettier', name, input))
  })

  it('keeps the 100-column width rather than falling back to 80', () => {
    const ninety = `export const s = '${'x'.repeat(70)}'\n`
    expect(format('oxfmt', 'width.ts', ninety)).toBe(ninety)
  })

  it('formats the same option set the ESLint stack uses', async () => {
    // Not a duplicate of the diff tests: those would still pass if BOTH configs
    // drifted together. This pins the two packages to one opinion, which is the
    // reason `@mnci/eslint-config` owns Prettier in the first place.
    const oxfmtModule = await import(join(packageRoot, 'oxfmt.js'))
    const prettierModule = await import(join(packageRoot, '..', 'eslint-config', 'prettier.js'))
    expect(oxfmtModule.default).toEqual(prettierModule.default)
  })
})
