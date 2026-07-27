import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * These are integration tests on purpose, and they shell out to the real
 * `eslint` binary rather than using its Node API.
 *
 * Two reasons, both load-bearing:
 *
 * 1. A flat config is declarative, so asserting on its object shape proves
 *    almost nothing — a rule can be present in the array and still be switched
 *    off again by a later block. That is exactly the failure mode
 *    `eslint-config-prettier` creates if composed in the wrong order, and it is
 *    the regression these tests exist to catch. Only running ESLint proves it.
 * 2. This package is ESM, and ESLint loads a flat config via dynamic
 *    `import()`. Jest runs these specs as CJS, and its module registry
 *    intercepts that import and fails ("A dynamic import callback was invoked
 *    without --experimental-vm-modules", and still fails with the flag on).
 *    A subprocess sidesteps Jest's loader entirely — and it is what a user's
 *    `npm run lint` actually does, so it is the more faithful test regardless.
 *
 * The whole fixture set is linted in ONE subprocess in `beforeAll`, so the
 * suite pays for a single ESLint startup rather than one per assertion.
 */

const packageRoot = join(__dirname, '..')
const eslintBin = join(packageRoot, '..', '..', 'node_modules', '.bin', 'eslint')

/** Every fixture: filename → contents. Linted together, asserted individually. */
const FIXTURES: Record<string, string> = {
  'ok.ts': 'export const a = 1\n',
  'bad.ts':
    'const unused = 1\nexport function f (): string {\n  const x: any = 2\n  return x == 2\n}\n',
  'spacing.ts': 'export function f() {\n  return 1\n}\n',
  'comment.ts': '//not spaced\nexport const a = 1\n',
  'members.ts':
    'export class C {\n  a(): number {\n    return 1\n  }\n  b(): number {\n    return 2\n  }\n}\n',
  'formatting.ts': 'export const a =        "x";\n',
  'dupe.json': '{"a": 1, "a": 2}\n',
  'dupe.json5': '{a: 1, a: 2}\n',
  'ci.yaml': 'a: 1\na: 2\n',
  'fine.yaml': 'a:\n  b: 1\n',
  'style.css': 'a { }\n',
  'page.html': '<html><body><img src="x.png"></body></html>\n',
  'doc.md': '[link]()\n',
  'thing.spec.ts':
    "describe('x', () => {\n  it('y', () => {\n    const v: any = 1\n    expect(v).toBe(1)\n  })\n})\n",
  'focused.spec.ts':
    "describe.only('x', () => {\n  it('y', () => {\n    expect(1).toBe(1)\n  })\n})\n",
  'packages/thing/package.json': '{ "name": "thing", "version": "1.0.0" }\n',
}

let workspace: string
let reported: Record<string, string[]>

/** Writes a root config that loads this package exactly as a consumer would. */
function writeConfig(directory: string, options = ''): void {
  writeFileSync(
    join(directory, 'eslint.config.mjs'),
    `import mnci from ${JSON.stringify(join(packageRoot, 'index.js'))}\nexport default mnci(${options})\n`
  )
}

/** Runs the real eslint over `directory`, returning filename → reported rule IDs. */
function lintAll(directory: string): Record<string, string[]> {
  const result = spawnSync(
    eslintBin,
    ['.', '--format', 'json', '--no-error-on-unmatched-pattern'],
    {
      cwd: directory,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }
  )
  const stdout = result.stdout?.trim()
  if (!stdout?.startsWith('[')) {
    throw new Error(`eslint produced no JSON.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  }
  const parsed = JSON.parse(stdout) as {
    filePath: string
    messages: { ruleId: string | null }[]
  }[]
  const byFile: Record<string, string[]> = {}
  for (const file of parsed) {
    const relative = file.filePath.slice(directory.length + 1).replaceAll('\\', '/')
    byFile[relative] = file.messages.map(message => message.ruleId ?? 'FATAL')
  }
  return byFile
}

/** The rule IDs reported for one fixture (empty when it linted clean). */
function rulesFor(filename: string): string[] {
  return reported[filename] ?? []
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mnci-eslint-config-'))
  writeConfig(workspace)
  for (const [filename, contents] of Object.entries(FIXTURES)) {
    const target = join(workspace, filename)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  reported = lintAll(workspace)
})

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('@mnci/eslint-config', () => {
  it('loads through the real eslint binary and leaves clean code alone', () => {
    expect(rulesFor('ok.ts')).toEqual([])
  })

  it('enforces correctness rules on TypeScript', () => {
    const rules = rulesFor('bad.ts')

    expect(rules).toContain('unused-imports/no-unused-vars')
    expect(rules).toContain('@typescript-eslint/no-explicit-any')
    expect(rules).toContain('eqeqeq')
  })

  it('keeps the Standard rules Prettier never touches, despite eslint-config-prettier', () => {
    // The regression this guards: eslint-config-prettier is composed last to
    // switch off formatting rules, and would silently kill these too if the
    // stylistic block were placed before it instead of after.
    expect(rulesFor('comment.ts')).toContain('@stylistic/spaced-comment')
    expect(rulesFor('members.ts')).toContain('@stylistic/lines-between-class-members')
  })

  it('never re-enables a rule that would fight Prettier', () => {
    // `space-before-function-paren` is Standard's signature rule and the
    // tempting thing to add back. It must stay off: Prettier rewrites
    // `function f (a)` to `function f(a)` on every run, so enabling it makes
    // `npm run lint` and `npm run format:check` mutually unsatisfiable.
    expect(rulesFor('spacing.ts')).not.toContain('@stylistic/space-before-function-paren')
  })

  it('does NOT re-enable the formatting rules Prettier owns', () => {
    // Badly indented, double-quoted, semicolon-terminated — all Prettier's job.
    const stylistic = rulesFor('formatting.ts').filter(rule => rule.startsWith('@stylistic/'))

    expect(stylistic).toEqual([])
  })

  it('lints JSON and JSON5', () => {
    expect(rulesFor('dupe.json')).toContain('jsonc/no-dupe-keys')
    expect(rulesFor('dupe.json5')).toContain('jsonc/no-dupe-keys')
  })

  it('lints YAML — a duplicate key in CI config is a hard failure', () => {
    expect(rulesFor('ci.yaml')).toContain('FATAL')
    expect(rulesFor('fine.yaml')).toEqual([])
  })

  it('lints CSS', () => {
    expect(rulesFor('style.css')).toContain('css/no-empty-blocks')
  })

  it('lints HTML, including accessibility', () => {
    const rules = rulesFor('page.html')

    expect(rules).toContain('@html-eslint/require-img-alt')
    expect(rules).toContain('@html-eslint/require-lang')
  })

  it('lints Markdown', () => {
    expect(rulesFor('doc.md')).toContain('markdown/no-empty-links')
  })

  it('relaxes the strict TypeScript rules inside spec files', () => {
    expect(rulesFor('thing.spec.ts')).not.toContain('@typescript-eslint/no-explicit-any')
  })

  it('catches focused tests, which would silently skip the rest of a suite', () => {
    expect(rulesFor('focused.spec.ts')).toContain('jest/no-focused-tests')
  })

  it('omits the dependency-checks block unless a workspaceRoot is given', () => {
    // A workspace with no publishable npm packages should not pay for it.
    expect(rulesFor('packages/thing/package.json')).not.toContain('@nx/dependency-checks')
  })

  it('wires dependency-checks in when a workspaceRoot IS given', () => {
    // Separate workspace: this needs a different composition of the config.
    const scoped = mkdtempSync(join(tmpdir(), 'mnci-eslint-config-dc-'))
    try {
      writeConfig(scoped, `{ workspaceRoot: ${JSON.stringify(scoped)} }`)
      mkdirSync(join(scoped, 'packages/thing'), { recursive: true })
      writeFileSync(
        join(scoped, 'packages/thing/package.json'),
        '{ "name": "thing", "version": "1.0.0" }\n'
      )
      const printed = spawnSync(eslintBin, ['--print-config', 'packages/thing/package.json'], {
        cwd: scoped,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      })

      expect(printed.stdout).toContain('@nx/dependency-checks')
    } finally {
      rmSync(scoped, { recursive: true, force: true })
    }
  })
})
