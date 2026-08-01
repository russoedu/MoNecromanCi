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
  // The exact shape `@nx/react:library --bundler=rollup` emits into the rollup
  // config it writes for every react-lib.
  'rollup.fixture.ts': 'export const options = { limit: 10000 }\n',

  // A generated project's real layout, which is what the type-aware rules are
  // scoped to: `packages/<name>/src/**` with a tsconfig covering it. Without a
  // fixture in this exact shape, those rules could be scoped to nothing at all
  // and every other test here would still pass.
  'packages/demo/tsconfig.json':
    '{\n  "compilerOptions": {\n    "target": "es2021",\n    "module": "commonjs",\n    "moduleResolution": "node",\n    "strict": true,\n    "noEmit": true\n  },\n  "include": ["src/**/*.ts"]\n}\n',
  'packages/demo/src/floating.ts':
    'async function work (): Promise<number> {\n  return 1\n}\n\nexport function go (): void {\n  work()\n}\n',
  'packages/demo/src/awaited.ts':
    'async function work (): Promise<number> {\n  return 1\n}\n\nexport async function go (): Promise<number> {\n  return await work()\n}\n',
  // An async callback passed where a void-returning one is expected. This is the
  // `checksVoidReturn.arguments` sub-check, which stays ON — it is where
  // no-misused-promises earns its keep, and it must survive the narrow
  // `attributes` relaxation React needs.
  'packages/demo/src/misused.ts':
    'function on (handler: () => void): void {\n  handler()\n}\n\nasync function work (): Promise<void> {\n  await Promise.resolve()\n}\n\nexport function wire (): void {\n  on(async () => {\n    await work()\n  })\n}\n',

  // JSX accessibility. `@html-eslint/require-img-alt` covers `**/*.html` only, so
  // an <img> in a component used to be checked by nothing at all.
  'a11y.tsx': 'export const Bad = (): JSX.Element => <img src="x.png" />\n',
  'a11y-ok.tsx': 'export const Good = (): JSX.Element => <img src="x.png" alt="a cat" />\n',
  // Vitest's `vi` belongs to no Jest environment, so a .js spec using it reported
  // `'vi' is not defined`.
  'vitest.spec.js':
    "describe('x', () => {\n  it('y', () => {\n    const spy = vi.fn()\n    expect(spy).toBeDefined()\n  })\n})\n",
  // TypeScript and VS Code both read comments in these, so forbidding them is
  // wrong — and they match `**/*.json` too, which is what made it happen.
  'tsconfig.probe.json': '{\n  // a comment TypeScript accepts\n  "compilerOptions": {}\n}\n',
  'strict.json': '{\n  "a": 1\n}\n',

  // Regex correctness. An unused capturing group is the cheap finding; the reason
  // this plugin is here is `no-super-linear-backtracking`, which catches a regex
  // that is correct but takes exponential time on a crafted input.
  'redos.js': 'export const slow = /^(a+)+$/\nexport const ok = /^a+$/\n',
  'group.js': "export const hit = /^x(y|z)$/.test('xy')\n",
  // The exact pyproject.toml @mnci/nx-python-pip generates. `flat/standard` reports
  // six array-bracket-spacing errors on this, which would have failed every Python
  // workspace's lint out of the box — hence `flat/base` and this regression guard.
  'pyproject.toml':
    '[project]\nname = "pyshared"\nversion = "1.0.0"\ndescription = ""\nrequires-python = ">=3.9"\ndependencies = []\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n\n[tool.hatch.build.targets.wheel]\npackages = ["pyshared"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
  'malformed.toml': '[project]\nname = "broken"\nversion = \n',

  // Import-graph correctness, all INSIDE one project — the gap
  // @nx/enforce-module-boundaries does not cover, since it only sees edges
  // between projects. The resolver must follow an extensionless relative
  // TypeScript import, which Node's algorithm cannot: with the default resolver
  // these three files reported false 'unresolved' errors instead.
  'packages/demo/src/selfish.ts': "import './selfish.js'\n\nexport const s = 1\n",
  'packages/demo/src/cycleA.ts':
    "import { fromB } from './cycleB.js'\n\nexport function fromA (): number {\n  return fromB() + 1\n}\n",
  'packages/demo/src/cycleB.ts':
    "import { fromA } from './cycleA.js'\n\nexport function fromB (): number {\n  return fromA() - 1\n}\n",
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

/**
 * The config ESLint actually resolves for one file, via `--print-config`.
 *
 * @remarks
 * For asserting a rule's *options* rather than whether it fires. Still the real
 * binary — and unlike importing `index.js`, it reports the value after every
 * block in the array has been merged, which is the only value that matters.
 * (Importing is also not available here: this package is ESM and Jest runs these
 * specs as CJS — see this file's header.)
 * @param directory - Workspace root to resolve from.
 * @param filename - File whose resolved config is wanted, relative to `directory`.
 * @returns The parsed config, with its `rules` map.
 */
function printConfig(directory: string, filename: string): { rules: Record<string, unknown[]> } {
  const result = spawnSync(eslintBin, ['--print-config', filename], {
    cwd: directory,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const stdout = result.stdout?.trim()
  if (!stdout?.startsWith('{')) {
    throw new Error(`eslint --print-config produced no JSON.\nstderr: ${result.stderr}`)
  }
  return JSON.parse(stdout) as { rules: Record<string, unknown[]> }
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

  it('does not fail generated build config over numeric separators', () => {
    // `@nx/react:library --bundler=rollup` writes `url({ limit: 10000 })` into
    // the rollup config it generates, so unicorn/numeric-separators-style made a
    // freshly added react-lib fail `npm run lint` on a file the user never
    // touched. It is also pure formatting, which is Prettier's job here — and
    // Prettier does not rewrite numeric separators, so the rule could never be
    // satisfied automatically.
    expect(rulesFor('rollup.fixture.ts')).not.toContain('unicorn/numeric-separators-style')
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

  it('catches a floating promise, which nothing else in the stack reports', () => {
    // The whole justification for type-aware linting: a dropped `await`
    // type-checks cleanly, so `tsc` and every non-type-aware rule stay silent,
    // and it only surfaces as a lost error at runtime.
    expect(rulesFor('packages/demo/src/floating.ts')).toContain(
      '@typescript-eslint/no-floating-promises'
    )
  })

  it('leaves a correctly awaited promise alone', () => {
    expect(rulesFor('packages/demo/src/awaited.ts')).toEqual([])
  })

  it('still catches an async callback passed where a void return is expected', () => {
    // The half of no-misused-promises that must survive the React relaxation
    // below. Without this, switching `checksVoidReturn` off wholesale would look
    // identical to switching off only `attributes`.
    expect(rulesFor('packages/demo/src/misused.ts')).toContain(
      '@typescript-eslint/no-misused-promises'
    )
  })

  it('exempts JSX attributes from checksVoidReturn, and ONLY attributes', () => {
    // `onClick={async () => { await save() }}` is the universal React idiom, but
    // React's prop types declare a void return, so the default setting fails a
    // freshly generated react-app on a file the user wrote normally — verified on
    // a real generated workspace, not reasoned about.
    //
    // Asserted on the resolved options because reproducing the attributes case
    // needs JSX plus React's types, which this fixture workspace has no reason to
    // install. The sub-check that catches real bugs is covered by the test above,
    // running the real binary.
    const [, options] = printConfig(workspace, 'packages/demo/src/awaited.ts').rules[
      '@typescript-eslint/no-misused-promises'
    ]

    expect(options).toEqual({ checksVoidReturn: { attributes: false } })
  })

  it('never reports a fatal parse error on a .ts file outside a project directory', () => {
    // The safety property that decided the scoping. A file in no tsconfig is a
    // FATAL for the type-aware parser, and a fatal suppresses every other rule
    // for that file — so a mis-scoped config does not merely lose these rules, it
    // stops linting the file entirely while failing the build. `bad.ts` sits at
    // the workspace root, in no tsconfig, and must still be linted normally.
    const rules = rulesFor('bad.ts')

    expect(rules).not.toContain('FATAL')
    expect(rules).toContain('@typescript-eslint/no-explicit-any')
  })

  it('lints JSX accessibility, not just HTML', () => {
    // The largest coverage hole this config had: two React project kinds and no
    // a11y rule reaching a single line of JSX.
    expect(rulesFor('a11y.tsx')).toContain('jsx-a11y/alt-text')
    expect(rulesFor('a11y-ok.tsx')).toEqual([])
  })

  it("knows Vitest's `vi`, which belongs to no Jest environment", () => {
    expect(rulesFor('vitest.spec.js')).not.toContain('no-undef')
  })

  it('allows comments in tsconfig.json, which TypeScript itself reads', () => {
    // Subtler than it looks, and the reason this needs a test: these files were
    // ALREADY listed as JSONC, but they also match `**/*.json`, and the JSONC
    // preset omits `jsonc/no-comments` rather than setting it 'off' — so the
    // strict block's 'error' survived into them.
    expect(rulesFor('tsconfig.probe.json')).not.toContain('jsonc/no-comments')
  })

  it('still forbids comments in a plain .json file', () => {
    // The other half: relaxing JSONC must not relax real JSON. Asserted on the
    // resolved config, since a clean file reports nothing either way.
    const [severity] = printConfig(workspace, 'strict.json').rules['jsonc/no-comments']

    expect(severity).toBe(2)
  })

  it('catches an import cycle inside a single project', () => {
    // @nx/enforce-module-boundaries sees cycles between PROJECTS; a cycle among
    // one project's own modules was reported by nothing. It runs until it
    // doesn't: whichever module evaluates second sees a half-built namespace.
    expect(rulesFor('packages/demo/src/cycleA.ts')).toContain('import-x/no-cycle')
  })

  it('keeps import-x/no-unresolved OFF, which this layout requires', () => {
    // Not a tuning choice. A project consumes an internal lib by scoped name, npm
    // workspaces symlinks it, and its manifest points at ./dist — which does not
    // exist until that dependency is BUILT, and `lint` does not depend on `build`.
    // Verified on a real generated workspace: a lib re-exporting `@scope/core`
    // reported it as unresolved. Pinned so nobody re-enables it in good faith.
    const [severity] = printConfig(workspace, 'packages/demo/src/cycleA.ts').rules[
      'import-x/no-unresolved'
    ]

    expect(severity).toBe(0)
  })

  it('catches a file importing itself', () => {
    expect(rulesFor('packages/demo/src/selfish.ts')).toContain('import-x/no-self-import')
  })

  it('catches a regex that backtracks catastrophically', () => {
    // The rule that justifies the plugin: /^(a+)+$/ is a correct regex that takes
    // exponential time on a crafted input — a real denial of service, and invisible
    // to review. Nothing else in this config looks inside a regex.
    expect(rulesFor('redos.js')).toContain('regexp/no-super-linear-backtracking')
  })

  it('catches a capturing group whose value is never read', () => {
    expect(rulesFor('group.js')).toContain('regexp/no-unused-capturing-group')
  })

  it('parses TOML and reports a malformed pyproject.toml as fatal', () => {
    // mnci writes pyproject.toml for every Python project and nothing read them, so
    // a syntax error surfaced much later as a confusing hatchling/pip failure.
    expect(rulesFor('malformed.toml')).toContain('FATAL')
  })

  it('leaves the pyproject.toml mnci itself generates completely alone', () => {
    // The regression guard that decided flat/base over flat/standard: standard
    // reports six toml/array-bracket-spacing errors on this exact content, so every
    // generated Python workspace would have failed `npm run lint` on a file the user
    // never wrote — the react-lib rollup config bug all over again.
    expect(rulesFor('pyproject.toml')).toEqual([])
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
