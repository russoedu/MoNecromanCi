import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * `markdown/no-invalid-label-refs` CRASHES the whole `eslint` invocation on a
 * Confluence-style `[label|url]` link, so `mnci/markdown` keeps it off.
 *
 * @remarks
 * The failure mode is what makes this worth a test rather than a comment. The
 * rule reaches a node carrying neither ESTree `range` nor mdast `position`
 * offsets; `@eslint/plugin-kit`'s `getText()` throws
 * `Custom getRange() method must be implemented in the subclass`; ESLint then
 * tries to attach a line number to that error, calls `getLoc()` on the same
 * node and throws a SECOND time. The user sees only the second throw, which
 * names neither the file, nor the rule, nor the real method — and `eslint .`
 * exits 2, taking `npm run format`, `nx run-many -t lint` and `mnci upgrade`'s
 * format pass with it, over one line of prose in one file.
 *
 * Found in a real workspace: `mnci upgrade` died on a brief pasted from a wiki.
 *
 * Content, not versions. The same one-line fixture reproduces identically on
 * eslint 10.9.1 and 10.11.0 and on `@eslint/plugin-kit` 0.7.2 and 0.7.3, and
 * `@eslint/markdown` 8.0.3 is the latest published release, so there is no
 * fixed version to move to.
 *
 * WHEN THE SECOND TEST STARTS FAILING, upstream has stopped throwing. That is
 * the signal to re-enable the rule and delete this file.
 */

const packageRoot = join(__dirname, '..')
const eslintBin = join(packageRoot, '..', '..', 'node_modules', '.bin', 'eslint')

/** The pattern that triggers it: a wiki link, which is not Markdown. */
const WIKI_LINK = 'Text with [Levenshtein distance|https://example.invalid/x] inline.\n'

let workspace: string

/**
 * Runs the real eslint binary over one file in a throwaway workspace.
 *
 * @param rules - Extra rules merged over the shared config, as JSON.
 * @returns The exit status and the combined output.
 */
function lintWikiLink (rules = '{}'): { status: number | null, output: string } {
  const entry = pathToFileURL(join(packageRoot, 'index.js')).href
  writeFileSync(
    join(workspace, 'eslint.config.mjs'),
    `import mnci from ${JSON.stringify(entry)}\n` +
    `export default [...mnci(), { files: ['**/*.md'], rules: ${rules} }]\n`,
  )
  writeFileSync(join(workspace, 'note.md'), WIKI_LINK)
  const result = spawnSync(eslintBin, ['note.md'], {
    cwd:      workspace,
    encoding: 'utf8',
    shell:    process.platform === 'win32',
  })

  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mnci-markdown-crash-'))
  // A self-contained tsconfig, so the TypeScript resolver behind
  // `import-x/no-cycle` stops here instead of walking up into whatever the OS
  // temp directory happens to contain.
  writeFileSync(join(workspace, 'tsconfig.json'), '{ "compilerOptions": {} }\n')
  mkdirSync(join(workspace, 'src'), { recursive: true })
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('markdown/no-invalid-label-refs', () => {
  it('is off, so a wiki-style link lints cleanly instead of killing the run', () => {
    const { status, output } = lintWikiLink()

    expect(output).not.toContain('must be implemented in the subclass')
    expect(status).toBe(0)
  })

  it('still CRASHES when switched on — pinned, so re-enabling cannot slip through', () => {
    /*
     * The inverse assertion, and the reason this is a test rather than a
     * comment: without it, someone re-enabling the rule in good faith would
     * see a green suite and ship a config that dies on a wiki link.
     *
     * Exit 2 is ESLint's "the run itself failed", distinct from exit 1, which
     * is "the run worked and found problems".
     */
    const { status, output } = lintWikiLink('{ "markdown/no-invalid-label-refs": "error" }')

    expect(output).toContain('must be implemented in the subclass')
    expect(status).toBe(2)
  })

  it('keeps the markdown rules that do work', () => {
    // Turning one rule off must not quietly cost the block its purpose:
    // `no-empty-links` is the other rule `mnci/markdown` enables.
    writeFileSync(join(workspace, 'note.md'), 'An [empty link]() here.\n')
    const entry = pathToFileURL(join(packageRoot, 'index.js')).href
    writeFileSync(
      join(workspace, 'eslint.config.mjs'),
      `import mnci from ${JSON.stringify(entry)}\nexport default mnci()\n`,
    )
    const result = spawnSync(eslintBin, ['note.md'], {
      cwd:      workspace,
      encoding: 'utf8',
      shell:    process.platform === 'win32',
    })

    expect(`${result.stdout}${result.stderr}`).toContain('no-empty-links')
  })
})
