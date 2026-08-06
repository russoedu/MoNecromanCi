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
  'packages/demo/src/disabled.ts': '/* eslint-disable */\nexport const anything = 1\n',
  // A React component with no return annotation, which is EXACTLY the shape of
  // Nx's generated `app.tsx` and `nx-welcome.tsx`. This is the regression that
  // reached a real generated workspace: `mnci add react-app` under oxlint failed
  // `npm run lint` on two files the user had never opened, because
  // `mnci/react`'s one `'off'` entry was missed when this config's React block
  // was derived by diffing only the rules that block turns ON.
  'packages/demo/src/component.tsx':
    "export function App() {\n  return <div className='x'>hi</div>\n}\n",
  // ...while a plain `.ts` still requires the annotation, so the fixture above
  // cannot pass by switching the rule off everywhere. `native.js` keeps it on
  // here, where a return type is real API surface.
  'packages/demo/src/annotated.ts': 'export function id(n: number): number {\n  return n\n}\n',
  // Vendor declarations legitimately re-declare and use `any`. A `.d.ts` matches
  // the TS-scoped override, so this is clean only because
  // `configs/declarations.js` takes those rules back off — the same class of gap
  // as the `.tsx` above, found by enumeration rather than by tripping over it.
  'packages/demo/src/vendor.d.ts':
    'declare module "vendor" {\n  export function anything(x: any): any\n}\n'
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

/**
 * The oxlint name for an ESLint rule.
 *
 * @remarks
 * unicorn comes through the JS bridge under its own namespace, so a disable has
 * to name the bridged rule rather than oxlint's partial native one (which
 * `leaks.js` switches off wholesale).
 *
 * @param rule - The ESLint rule name.
 * @returns The same rule as oxlint spells it.
 */
const oxlintName = (rule: string): string =>
  rule.startsWith('@typescript-eslint/')
    ? rule.replace('@typescript-eslint/', 'typescript/')
    : rule.replace(/^unicorn\//, 'unicorn-js/')

/**
 * The severity of a rule setting, whether or not it carries options.
 *
 * @param setting - A rule's configured value.
 * @returns The severity alone.
 */
const level = (setting: unknown): unknown => (Array.isArray(setting) ? setting[0] : setting)

describe('every rule the ESLint config disables in a scoped block is disabled here too', () => {
  /**
   * The class of bug this exists for, stated once because two instances shipped:
   *
   * This config's scoped blocks were derived by diffing the ESLint config's
   * resolved rules for one file type against another, which surfaces every rule
   * a block turns **on** and none of the rules it turns **off**. So
   * `mnci/react`'s single `'off'` entry — `explicit-function-return-type`, off
   * because a component's return type is always inferred JSX — was missed, and
   * oxlint ended up STRICTER than ESLint on `.tsx`. A fresh `mnci add react-app`
   * then failed lint on Nx's own generated files. The `.d.ts` blocks had the
   * same gap and had simply never been exercised.
   *
   * The fixtures above pin those two instances behaviourally. This pins the
   * property, so the next scoped `'off'` added on the ESLint side cannot go
   * unmirrored just because nobody thought to write a fixture for it.
   *
   * Static, deliberately: it reads both config objects rather than linting, and
   * a rule's mere presence is exactly what is being asserted. A behavioural
   * version would need a fixture per rule, which is the thing that did not
   * happen.
   */

  /**
   * Resolves both configs in one subprocess.
   *
   * @returns The ESLint config's scoped disables, and the oxlint config.
   * @throws If either config fails to resolve.
   */
  function configs(): {
    scopedDisables: { rule: string; by: string; files: string[] }[]
    oxlint: {
      rules?: Record<string, unknown>
      overrides?: { files: string[]; rules?: Record<string, unknown> }[]
    }
  } {
    const script = `
      const eslintConfig = (await import(${JSON.stringify(
        join(packageRoot, '..', 'eslint-config', 'index.js')
      )})).default
      const oxlintConfig = (await import(${JSON.stringify(join(packageRoot, 'index.js'))})).default
      const blocks = eslintConfig({})
      const level = setting => (Array.isArray(setting) ? setting[0] : setting)
      const state = new Map()
      const scopedDisables = []
      for (const block of blocks) {
        for (const [rule, setting] of Object.entries(block.rules ?? {})) {
          // Only a disable that REVERSES an earlier enable matters. A rule that
          // was never on needs no mirror.
          if (level(setting) === 'off' && state.get(rule) && state.get(rule) !== 'off' && block.files) {
            scopedDisables.push({ rule, by: block.name, files: block.files })
          }
          state.set(rule, level(setting))
        }
      }
      process.stdout.write(JSON.stringify({ scopedDisables, oxlint: oxlintConfig({}) }))
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    })
    const stdout = result.stdout?.trim() ?? ''
    if (!stdout.startsWith('{')) {
      throw new Error(`could not resolve the configs.\nstderr: ${result.stderr}`)
    }
    return JSON.parse(stdout) as ReturnType<typeof configs>
  }

  const { scopedDisables, oxlint } = configs()

  /** Every rule this config sets anywhere, with the scopes that disable it. */
  const enabledSomewhere = new Set<string>()
  const disabledIn: { files: string[]; rules: Set<string> }[] = []
  const baseRules = Object.entries(oxlint.rules ?? {})
  for (const [rule, setting] of baseRules) {
    if (level(setting) !== 'off') enabledSomewhere.add(rule)
  }
  const overrides = oxlint.overrides ?? []
  for (const override of overrides) {
    const disabled = new Set<string>()
    const overrideRules = Object.entries(override.rules ?? {})
    for (const [rule, setting] of overrideRules) {
      if (level(setting) === 'off') disabled.add(rule)
      else enabledSomewhere.add(rule)
    }
    disabledIn.push({ files: override.files, rules: disabled })
  }

  /** The extensions oxlint parses. Everything else it never opens. */
  const OXLINT_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue'])

  /**
   * Whether a scope can reach a file oxlint actually parses.
   *
   * @remarks
   * The one principled exemption, and it is a property rather than a list of
   * rule names: `mnci/yaml` disables `no-irregular-whitespace` for `*.yaml`, and
   * oxlint could not report it on a `.yaml` if it wanted to — it has no YAML
   * parser, which is the whole reason the CLI's oxlint mode keeps ESLint for
   * those files. Mirroring such a disable would be noise asserting nothing.
   *
   * Unrecognised scopes count as reachable, so a scope this cannot classify
   * demands the mirror rather than being waved through.
   *
   * @param patterns - The ESLint block's `files` patterns.
   * @returns Whether any pattern can match a file oxlint parses.
   */
  const reachesOxlint = (patterns: string[]): boolean =>
    patterns.some(pattern => {
      const braced = (pattern.match(/\{([^}]+)\}/g) ?? []).flatMap(group =>
        group.slice(1, -1).split(',')
      )
      const trailing = /\.([a-z]+)$/.exec(pattern)?.[1]
      const extensions = [...braced, ...(trailing ? [trailing] : [])].map(part => part.trim())
      return extensions.length === 0 || extensions.some(part => OXLINT_EXTENSIONS.has(part))
    })

  // The ones that need mirroring: a rule this config actually enables, disabled
  // by a scoped ESLint block, on files oxlint parses. A rule oxlint has no
  // equivalent for (169 unicorn and 56 regexp rules do not exist natively, and
  // plenty of core rules are simply absent) needs nothing.
  const mustMirror = scopedDisables.filter(
    entry => enabledSomewhere.has(oxlintName(entry.rule)) && reachesOxlint(entry.files)
  )

  it('found scoped disables to check, so this is not vacuously green', () => {
    // Without this the suite would pass just as happily if `configs()` started
    // returning an empty list — which is how a guard becomes decoration.
    expect(mustMirror.length).toBeGreaterThan(0)
  })

  it.each(mustMirror.map(entry => [`${entry.rule} (${entry.by})`, entry]))(
    'mirrors %s',
    (_label, entry) => {
      const rule = oxlintName((entry as { rule: string }).rule)
      const files = (entry as { files: string[] }).files
      // The oxlint override has to disable the rule AND cover every pattern the
      // ESLint block scopes it to. Covering fewer patterns would leave the rule
      // live on some of the files ESLint exempts, which is the same defect in a
      // narrower form.
      const mirrored = disabledIn.some(
        override =>
          override.rules.has(rule) && files.every(pattern => override.files.includes(pattern))
      )
      expect(mirrored).toBe(true)
    }
  )
})
