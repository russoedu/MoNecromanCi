import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The promise this package makes, as a test.
 *
 * @remarks
 * **Anything `@mnci/eslint-config` accepts must pass oxlint.** That is the whole
 * contract, and it is directional on purpose. This config is allowed to be more
 * *permissive* than the ESLint one — 246 of the ESLint config's rules have no
 * oxlint implementation, so it unavoidably is. It is never allowed to be
 * *stricter*, because that is the case where a codebase that lints clean today
 * starts failing tomorrow, on files nobody touched.
 *
 * So the fixtures below are split by which side of that line they sit on:
 *
 * - `CLEAN` — real patterns the ESLint config lints clean. oxlint must report
 *   **nothing**. Every one of these is a pattern that has actually broken a
 *   generated workspace's lint at some point in this project's history, which is
 *   why they are these fixtures and not arbitrary ones.
 * - `CAUGHT` — genuine defects. oxlint must report, or this config is decoration.
 *
 * Both halves are needed. A config of nothing but `"off"` passes the first half
 * perfectly.
 *
 * Runs the real `oxlint` binary against a temp workspace, because asserting on
 * the config object proves nothing about what the linter does with it — the same
 * reasoning as the sibling package's specs. A subprocess is also required rather
 * than merely preferred: this package is ESM and these specs run as CJS under
 * ts-jest.
 */

const packageRoot = join(__dirname, '..')
const oxlintBin = join(packageRoot, '..', '..', 'node_modules', '.bin', 'oxlint')

/**
 * Patterns the ESLint stack accepts. oxlint must accept them too.
 *
 * Provenance, since it is the reason these are worth testing:
 * `numeric-separators` and the `NxWelcome` selector come from rules the ESLint
 * config had to switch off after a generated workspace failed lint on a file Nx
 * wrote; `nullReturn` and `cjsGlobals` come from `unicorn/no-null` and
 * `prefer-module`, off for the same class of reason.
 */
const CLEAN: Record<string, string> = {
  // `@nx/react:library --bundler=rollup` emits `url({ limit: 10000 })`.
  'packages/demo/src/numeric.ts': 'export const limit = 10000\n',
  // Nx's own generated jest config shape.
  'jest.config.ts': 'export default async () => ({ projects: [] })\n',
  // `unicorn/no-null` is off: null is a real API value.
  'packages/demo/src/nullReturn.ts': 'export function head(): string | null {\n  return null\n}\n',
  // An Nx monorepo is legitimately mixed CJS/ESM.
  'packages/demo/src/cjsGlobals.cjs':
    "const path = require('node:path')\nmodule.exports = path.sep\n",
  // Named imports are idiomatic; `unicorn/import-style` is off.
  'packages/demo/src/named.ts':
    "import { join } from 'node:path'\nexport const p = join('a', 'b')\n",
  // A `for` loop rather than `reduce`; `unicorn/no-array-reduce` is off.
  'packages/demo/src/sum.ts':
    'export function total(ns: number[]): number {\n  let out = 0\n  for (const n of ns) out += n\n  return out\n}\n',
  // Nx's generators emit files with a bare eslint-disable.
  'packages/demo/src/disabled.ts': '/* eslint-disable */\nexport const anything = 1\n'
  // No fixture for the `consistent-function-scoping` divergence recorded in
  // configs/divergences.js, deliberately. A minimal reproduction of it does not
  // exist: the obvious three-line version is reported by BOTH linters, so as a
  // "clean" fixture it was simply wrong — it asserted ESLint accepts something
  // it rejects. The divergence only appears on the real
  // `packages/cli/src/commands/add/shared.ts`, and a fixture that has to be a
  // 400-line file copied out of another package would rot the first time that
  // file changed. Recorded there with its reproduction instead of faked here.
}

/** Real defects. oxlint must report each, or this config is not doing its job. */
const CAUGHT: Record<string, string> = {
  'packages/demo/src/varUse.js': 'export function f() {\n  var x = 1\n  return x\n}\n',
  'packages/demo/src/loose.js': 'export const same = (a, b) => a == b\n',
  // eslint-plugin-regexp, via the JS bridge — one of the 246 rules oxlint has no
  // native implementation for, so this also proves the bridge is live.
  'packages/demo/src/backtrack.js': 'export const re = /^(a+)+$/\n'
}

let workspace: string
/**
 * One lint of every fixture, shared by the assertions below.
 *
 * Not an optimisation for its own sake: the JS bridge boots Node and loads both
 * ESLint plugins on every invocation (~2s), so linting per assertion made the
 * suite take minutes. Same pattern as the sibling package's `config.spec.ts`.
 */
let reported: Record<string, string[]>

/**
 * Lints the whole temp workspace and returns the rule codes reported.
 *
 * @param typeAware - Whether to pass `--type-aware`.
 * @returns Reported entries as `file -> rule codes`.
 * @throws If oxlint produces no parseable JSON.
 */
function lint(typeAware = false): Record<string, string[]> {
  // Explicit fixture paths rather than `.`: this workspace's `node_modules` is a
  // set of symlinks into the real one, and oxlint follows them. Linting `.` took
  // 223s and produced 1MB of findings about other people's code, which then blew
  // spawnSync's default buffer. The `ignorePatterns` in the config are not enough
  // on their own, so the paths are the fix.
  const args = [
    '--format',
    'json',
    '--no-error-on-unmatched-pattern',
    ...(typeAware ? ['--type-aware'] : []),
    'packages',
    'jest.config.ts'
  ]
  const result = spawnSync(oxlintBin, args, {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === 'win32'
  })
  const stdout = result.stdout?.trim() ?? ''
  if (!stdout.startsWith('{') && !stdout.startsWith('[')) {
    throw new Error(`oxlint produced no JSON.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  }
  const parsed = JSON.parse(stdout) as
    | { filename?: string; code?: string }[]
    | { diagnostics?: { filename?: string; code?: string }[] }
  const diagnostics = Array.isArray(parsed) ? parsed : (parsed.diagnostics ?? [])
  const byFile: Record<string, string[]> = {}
  for (const d of diagnostics) {
    const file = (d.filename ?? '').replaceAll('\\', '/').replace(/^\.\//, '')
    ;(byFile[file] ??= []).push(d.code ?? '?')
  }
  return byFile
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mnci-oxlint-'))

  // The config is loaded by bare specifier from an oxlint.config.ts, which is
  // the only shareable-config route oxlint offers — .oxlintrc.json's `extends`
  // is path-only. A node_modules symlink is what npm workspaces creates.
  mkdirSync(join(workspace, 'node_modules', '@mnci'), { recursive: true })
  symlinkSync(packageRoot, join(workspace, 'node_modules', '@mnci', 'oxlint-config'), 'junction')
  // Three things have to resolve from the temp workspace, and each for its own
  // reason — worth spelling out, since a missing one fails as an opaque
  // "Cannot find package" from inside oxlint rather than as a test assertion:
  //   - `oxlint`, because oxlint.config.ts imports `defineConfig` from it;
  //   - the two ESLint plugins, because the JS bridge resolves its specifiers
  //     relative to the CONFIG FILE, not relative to this package.
  for (const dependency of ['oxlint', 'eslint-plugin-unicorn', 'eslint-plugin-regexp']) {
    symlinkSync(
      join(packageRoot, '..', '..', 'node_modules', dependency),
      join(workspace, 'node_modules', dependency),
      'junction'
    )
  }

  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ name: 'probe', private: true, type: 'module' })
  )
  writeFileSync(
    join(workspace, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'es2022',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        strict: true
      },
      include: ['packages/*/src/**/*.ts']
    })
  )
  writeFileSync(
    join(workspace, 'oxlint.config.ts'),
    "import { defineConfig } from 'oxlint'\n" +
      "import mnci from '@mnci/oxlint-config'\n\n" +
      'export default defineConfig({ extends: [mnci()] })\n'
  )

  const fixtures = Object.entries({ ...CLEAN, ...CAUGHT })
  for (const [name, contents] of fixtures) {
    const target = join(workspace, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents.replaceAll('%27', "'"))
  }

  reported = lint()
})

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('oxlint accepts everything @mnci/eslint-config accepts', () => {
  it.each(Object.keys(CLEAN))('reports nothing on %s', file => {
    expect(reported[file] ?? []).toEqual([])
  })

  it('reports nothing at all across every clean fixture', () => {
    // The per-file assertions above could all pass while a finding lands on a
    // path none of them names. This is the version that cannot.
    const cleanFiles = new Set(Object.keys(CLEAN))
    expect(Object.entries(reported).filter(([file]) => cleanFiles.has(file))).toEqual([])
  })
})

describe('and still catches real defects', () => {
  it.each(Object.keys(CAUGHT))('reports on %s', file => {
    expect((reported[file] ?? []).length).toBeGreaterThan(0)
  })

  it('runs the bridged ESLint plugins, not just oxlint natives', () => {
    // regexp has no native oxlint implementation, so a finding here proves the
    // jsPlugins bridge is live — the mechanism closing 246 missing rules.
    expect(reported['packages/demo/src/backtrack.js']?.join(' ')).toMatch(/regexp/)
  })
})

describe('the type-aware rules', () => {
  it('catches a floating promise, and only with --type-aware', () => {
    const file = 'packages/demo/src/floating.ts'
    writeFileSync(
      join(workspace, file),
      'async function save(): Promise<void> {}\n\n' +
        'export function dropped(): void {\n  save()\n}\n'
    )
    try {
      // The rule is listed unconditionally but is inert without the flag; that
      // asymmetry is the thing worth pinning, since a workspace that forgets
      // --type-aware would otherwise silently lose the most valuable rule here.
      expect(lint(false)[file] ?? []).toEqual([])
      expect(lint(true)[file]?.join(' ')).toMatch(/no-floating-promises/)
    } finally {
      rmSync(join(workspace, file), { force: true })
    }
  })
})
