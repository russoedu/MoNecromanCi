import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * `@stylistic/key-spacing` with `align: { on: 'value' }` — the departure
 * `mnci/house-style` adopts — has a FIXER bug: it corrupts a TypeScript type
 * annotation that is wrapped entirely in parentheses.
 *
 * It rewrites the whitespace between the colon and the value, and on
 * `#p: (Date & { x: number })` it swallows the OPENING parenthesis while
 * leaving the closing one:
 *
 * ```ts
 * // before            after `eslint --fix`
 * #p: (Date & { x })   #p: Date & { x })
 * ```
 *
 * The result is a parse error, so `npm run format` turns valid TypeScript into
 * code that no longer compiles — silently, because `--fix` reports success and
 * the damage only surfaces on the next lint or typecheck. It was found that
 * way: a real package migrated into a generated workspace stopped building
 * after a routine format pass.
 *
 * These tests PIN THE BUG rather than assert the fix, because there is nothing
 * to fix it with:
 *
 * - @stylistic 5.10.0 is the latest stable release; 6.0.0 is in beta.
 * - `align: { on: 'colon' }` does not corrupt, but it aligns colons instead of
 *   values, which is not the style this package chose.
 * - `@stylistic/no-extra-parens` looks like a workaround and is not. On its own
 *   it removes those parentheses cleanly, but both rules want to rewrite the
 *   same range: key-spacing's fix starts earlier (at the whitespace), so ESLint
 *   applies it first and defers the other — by which point the source is
 *   already unparseable. Verified, so nobody re-tries it.
 *
 * WHEN THESE TESTS START FAILING, the bug has been fixed upstream. That is the
 * signal to drop the warning in `configs/houseStyle.js` and invert these
 * assertions.
 *
 * The blast radius is narrow, and the last two cases pin that too: only
 * parentheses wrapping the WHOLE annotation are affected. Parentheses that are
 * syntactically required — `(string | number)[]`, `(() => void) | undefined` —
 * survive, and object literals, the thing the alignment is actually for, are
 * untouched.
 */

const packageRoot = join(__dirname, '..')
const eslintBin = join(packageRoot, '..', '..', 'node_modules', '.bin', 'eslint')

/** What `--fix` produces for each fixture, keyed by filename. */
let fixedOutput: Record<string, string>
let workspace: string

const FIXTURES: Record<string, string> = {
  // The three TypeScript member forms that take a type annotation. All three
  // are corrupted; object literals are not, which is the last fixture.
  'class-property.ts':
    'export class C {\n  #a: string\n  #p: (Date & { x: number })\n  #z: number\n}\n',
  'interface-member.ts':
    'export interface I {\n  a: string\n  p: (Date & { x: number })\n  z: number\n}\n',
  'type-literal.ts':
    'export type T = {\n  a: string\n  p: (Date & { x: number })\n  z: number\n}\n',
  // Parentheses that carry meaning. `(string | number)[]` is an array of a
  // union, not a union with an array; dropping either parenthesis changes or
  // breaks the type. These survive.
  'required-parens.ts':
    'export class C {\n  #a: string\n  #union: (string | number)[]\n  #fn: (() => void) | undefined\n  #z: number\n}\n',
  // The case the departure exists for.
  'object-literal.ts':
    'export const o = {\n  name: 1,\n  description: 2,\n}\n',
}

/** Writes a root config that loads this package exactly as a consumer would. */
function writeConfig (directory: string): void {
  const entry = pathToFileURL(join(packageRoot, 'index.js')).href
  writeFileSync(
    join(directory, 'eslint.config.mjs'),
    `import mnci from ${JSON.stringify(entry)}\nexport default mnci()\n`,
  )
}

/**
 * Runs the real eslint with `--fix`, returning filename → fixed contents.
 *
 * @remarks
 * `--fix`, not `--fix-dry-run`: the point is what lands on disk, and reading
 * the files back is the same thing a developer sees after `npm run format`.
 * @param directory - Workspace root to lint.
 * @returns Each fixture's contents after the fix pass.
 */
function fixAll (directory: string): Record<string, string> {
  spawnSync(eslintBin, ['.', '--fix', '--no-error-on-unmatched-pattern'], {
    cwd:      directory,
    encoding: 'utf8',
    shell:    process.platform === 'win32',
  })
  const out: Record<string, string> = {}
  for (const filename of Object.keys(FIXTURES)) {
    out[filename] = readFileSync(join(directory, filename), 'utf8')
  }

  return out
}

/** The line holding the parenthesised annotation, for the fixture named. */
function annotationLine (filename: string, needle: string): string {
  const line = fixedOutput[filename]
    ?.split('\n')
    .find(candidate => candidate.includes(needle))

  return line ?? ''
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mnci-key-spacing-'))
  writeConfig(workspace)
  for (const [filename, contents] of Object.entries(FIXTURES)) {
    writeFileSync(join(workspace, filename), contents)
  }
  fixedOutput = fixAll(workspace)
}, 120_000)

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('@stylistic/key-spacing align, known fixer bug', () => {
  it.each([
    ['class-property.ts', '#p:'],
    ['interface-member.ts', 'p:'],
    ['type-literal.ts', 'p:'],
  ])('drops the opening parenthesis in %s', (filename, needle) => {
    const line = annotationLine(filename, needle)

    // Pinned, not desired: the opening parenthesis is gone and the closing one
    // is not, which is a parse error. Invert this when @stylistic fixes it.
    expect(line).toContain('Date & { x: number })')
    expect(line).not.toContain(': (Date')
  })

  it('leaves parentheses that are syntactically required alone', () => {
    const contents = fixedOutput['required-parens.ts'] ?? ''

    expect(contents).toContain('(string | number)[]')
    expect(contents).toContain('(() => void) | undefined')
  })

  it('still aligns object literal values, which is what the departure is for', () => {
    const contents = fixedOutput['object-literal.ts'] ?? ''

    // `description` is the longest key, so `name`'s value is padded out to it.
    expect(contents).toContain('name:        1,')
    expect(contents).toContain('description: 2,')
  })
})
