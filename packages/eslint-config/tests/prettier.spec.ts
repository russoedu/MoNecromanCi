import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The formatting half of this package, tested the same way the rules are: by
 * running the real `prettier` binary against fixtures in a temp workspace.
 *
 * Asserting the exported object's properties would be the easy version and would
 * prove less. What matters is that Prettier **resolves** a shareable config from
 * this package and then **applies** it — resolution and application are separate,
 * and the interesting failure is a config Prettier finds but silently ignores.
 * That is not hypothetical: mnci shipped exactly that bug, with a
 * `.prettierrc` outranking `.prettierrc.json` so every option was discarded.
 *
 * A subprocess is also required rather than convenient: this package is ESM and
 * these specs run as CJS under ts-jest, so `import`ing it here fails to parse.
 */

const packageRoot = join(__dirname, '..')
const prettierBin = join(packageRoot, '..', '..', 'node_modules', '.bin', 'prettier')

/** A `.prettierrc.mjs` that consumes this package, exactly as a workspace does. */
const CONSUMER_CONFIG = `export { default } from '@mnci/eslint-config/prettier'\n`

let workspace: string

/**
 * Formats one fixture through the real binary, with the config resolved from
 * disk rather than passed in — so resolution is part of what is under test.
 *
 * @param filename - Fixture name to create and format.
 * @param contents - Fixture contents.
 * @returns Prettier's output for that file.
 */
function format(filename: string, contents: string): string {
  const target = join(workspace, filename)
  writeFileSync(target, contents)
  const result = spawnSync(prettierBin, [target], {
    cwd: workspace,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) {
    throw new Error(`prettier failed on ${filename}: ${result.stderr}`)
  }
  return result.stdout
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mnci-prettier-'))
  writeFileSync(join(workspace, '.prettierrc.mjs'), CONSUMER_CONFIG)
  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ name: 'probe', private: true, type: 'module' })
  )
  // The config is loaded by its BARE specifier, so Node has to be able to
  // resolve it — which is the interesting half. `config.spec.ts` can point at an
  // absolute path because nothing about ESLint's behaviour depends on the
  // spelling; here the spelling IS the subject: the `exports` map must expose
  // `./prettier` and `files` must ship `prettier.js`, or a published consumer
  // gets ERR_PACKAGE_PATH_NOT_EXPORTED from a config that resolved fine in-repo.
  // A symlink into node_modules is exactly what npm workspaces creates.
  mkdirSync(join(workspace, 'node_modules', '@mnci'), { recursive: true })
  symlinkSync(packageRoot, join(workspace, 'node_modules', '@mnci', 'eslint-config'), 'junction')
})

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('@mnci/eslint-config/prettier', () => {
  it('is resolvable as a shareable config, not just importable', () => {
    const result = spawnSync(prettierBin, ['--find-config-path', 'probe.ts'], {
      cwd: workspace,
      encoding: 'utf8',
      shell: process.platform === 'win32'
    })

    expect(result.stdout.trim()).toBe('.prettierrc.mjs')
  })

  it('applies JavaScript Standard Style: no semicolons, single quotes', () => {
    // If Prettier resolved the config but ignored it, this would come back with
    // double quotes (its own default) and the semicolon intact.
    expect(format('quotes.ts', 'export const a = "double";\n')).toBe("export const a = 'double'\n")
  })

  it('forbids trailing commas, which is what `es5` got wrong', () => {
    // The regression this exists for. This repo's own config carried
    // `trailingComma: "es5"` while it SHIPPED `"none"`, so it was formatted
    // against an opinion it did not publish — 86 files' worth. Prettier's own
    // default is `"all"`, so leaving it unset would be wrong too.
    const multiline = 'export const o = {\n  a: 1,\n  b: 2,\n}\n'

    expect(format('commas.ts', multiline)).toBe('export const o = {\n  a: 1,\n  b: 2\n}\n')
  })

  it('avoids arrow parens and keeps the 100-column width', () => {
    expect(format('arrow.ts', 'export const f = (x) => x\n')).toBe('export const f = x => x\n')
    // 100, not Prettier's default 80: a line in between must survive unwrapped.
    const ninety = `export const s = '${'x'.repeat(70)}'\n`
    expect(format('width.ts', ninety)).toBe(ninety)
  })
})
