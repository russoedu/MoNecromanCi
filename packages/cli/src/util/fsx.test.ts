import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCodeWorkspace } from './fsx'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mnci-fsx-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Writes a fixture file and reads it back through `readCodeWorkspace`. */
function readFixture<T> (content: string): T | undefined {
  const path = join(dir, 'demo.code-workspace')
  writeFileSync(path, content)

  return readCodeWorkspace<T>(path)
}

describe('readCodeWorkspace', () => {
  it('parses plain JSON with no dialect quirks', () => {
    expect(readFixture('{"folders": [{"path": "."}]}')).toEqual({
      folders: [{ path: '.' }],
    })
  })

  it('tolerates a trailing comma before a closing brace or bracket', () => {
    expect(
      readFixture('{\n  "folders": [\n    { "path": "." },\n  ],\n}'),
    ).toEqual({ folders: [{ path: '.' }] })
  })

  it('strips a line comment, the reproduced bug — a single one used to fail the whole parse', () => {
    // Before the fix: JSON.parse throws on the very first `//`, every caller
    // treats the throw as "nothing to preserve", and folders/settings/
    // extensions/launch/tasks are all silently discarded on the next `mnci
    // add` or `mnci upgrade`. One comment line was enough to reproduce it.
    expect(
      readFixture(
        [
          '{',
          '  // eslint settings',
          '  "settings": { "editor.formatOnSave": true },',
          '  "folders": [{ "path": "." }]',
          '}',
        ].join('\n'),
      ),
    ).toEqual({
      settings: { 'editor.formatOnSave': true },
      folders:  [{ path: '.' }],
    })
  })

  it('strips a trailing line comment on the same line as real content', () => {
    expect(
      readFixture('{\n  "editor.tabSize": 2, // two spaces\n  "x": 1\n}'),
    ).toEqual({ 'editor.tabSize': 2, 'x': 1 })
  })

  it('strips a block comment, including one spanning multiple lines', () => {
    expect(
      readFixture(
        [
          '{',
          '  /*',
          '   * Multi-line explanation.',
          '   */',
          '  "x": 1',
          '}',
        ].join('\n'),
      ),
    ).toEqual({ x: 1 })
  })

  it('does not treat // or /* inside a string value as a comment', () => {
    // A real .code-workspace value that legitimately contains these
    // sequences — a URL — must survive intact, not be truncated.
    expect(readFixture('{"cSpell.words": ["https://example.com/*"]}')).toEqual({
      'cSpell.words': ['https://example.com/*'],
    })
  })

  it('does not let a quote inside a comment end a string early', () => {
    expect(
      readFixture('{\n  // don\'t confuse this "quote" for a string\n  "x": 1\n}'),
    ).toEqual({ x: 1 })
  })

  it('handles an escaped backslash immediately before a closing quote', () => {
    // A naive "toggle inString on every unescaped quote" scanner that only
    // checks the immediately preceding character breaks on this: the
    // string's real content is one backslash, escaped as `\\`, and the
    // closing quote must still be recognised as closing.
    expect(readFixture(String.raw`{"path": "C:\\"}`)).toEqual({ path: 'C:\\' })
  })

  it('strips a comment AND tolerates the trailing comma it can leave behind', () => {
    // Comments must be stripped before the trailing-comma pass: a line
    // comment on its own line right before a closing brace, once removed,
    // leaves exactly the trailing comma the second pass exists to catch.
    expect(
      readFixture(['{', '  "x": 1,', '  // trailing comment', '}'].join('\n')),
    ).toEqual({ x: 1 })
  })

  it('returns undefined for a missing file', () => {
    expect(readCodeWorkspace(join(dir, 'nope.code-workspace'))).toBeUndefined()
  })

  it('returns undefined for genuinely malformed JSON, rather than throwing', () => {
    expect(readFixture('{ this is not json')).toBeUndefined()
  })
})
