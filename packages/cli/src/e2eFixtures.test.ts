import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The e2e writes TypeScript fixtures into a generated workspace and then
 * requires that workspace to lint clean. Those fixtures therefore have to
 * satisfy the shipped config — and nothing checked that until a 50-minute
 * Windows run said so.
 *
 * It has now cost two nightlies. Turning `space-before-function-paren` on made
 * `apps/api/src/deps.ts` (`export function apiDeps(): string`) invalid, and the
 * suite reported it as `nx run-many -t lint,test,build succeeds` failing — a
 * label that points at mnci rather than at the harness's own source. The
 * fixture's own comment even predicted it: "it has to arrive clean or the
 * assertion below fails on the harness's own code rather than on anything mnci
 * produced."
 *
 * So the fixtures are linted here, in seconds, against the real binary.
 *
 * **Scope, stated honestly.** These files are linted standalone, outside a
 * generated workspace, so the type-aware block (which is scoped to project
 * source directories), import resolution and the Nx dependency checks do not
 * apply. Only the `mnci/standard` block's stylistic rules are asserted — which
 * is exactly the class that has broken twice, since those are the rules a
 * config change flips wholesale.
 */

/** The shape of one entry in `eslint --format json` output. */
interface LintResult {
  messages: { ruleId: string | null; message: string }[]
}

const E2E_FILE = join(__dirname, '..', 'e2e', 'cli.e2e.mjs')
const REPO_ROOT = join(__dirname, '..', '..', '..')

/**
 * The e2e fixtures whose contract is "must arrive already Standard-clean".
 *
 * @remarks
 * Read from an explicit `// @standard-clean` marker rather than inferred, and
 * the distinction is the whole design. Most fixtures the suite writes are
 * **deliberately** unformatted — semicolons, double quotes, no space before
 * parens — because each is followed by another `mnci add`, whose `eslint --fix`
 * pass normalises it in passing. That normalisation is itself the evidence the
 * pass works, so "fixing" those fixtures would delete a real assertion.
 *
 * Only the fixtures written after the last `add` have nothing behind them, and
 * those are the ones marked. The first version of this guard linted every
 * fixture it could find and reported four failures that were all correct-by-
 * design — a guard that would have been "fixed" by breaking the suite.
 *
 * @returns The marked fixtures' contents, keyed by the path they are written to.
 * @throws Propagates any Node.js `fs` error raised while reading the suite.
 * @typeParam None - this function has no generic type parameters.
 */
function markedFixtures (): Map<string, string> {
  const source = readFileSync(E2E_FILE, 'utf8')
  const pattern =
    /\/\/ @standard-clean[^\S\n]*\n\s*writeFileSync\(\s*path\.join\([^)]*?'([^']*\.ts)'\)\s*,\s*("(?:[^"\\]|\\.)*")\s*\)/g
  const fixtures = new Map<string, string>()
  for (const match of source.matchAll(pattern)) {
    const [, target, literal] = match
    fixtures.set(target, JSON.parse(literal) as string)
  }
  return fixtures
}

/**
 * Runs the real ESLint over one fixture and returns its `@stylistic` messages.
 *
 * @remarks
 * **`--stdin-filename`, a virtual path, never a file on disk.** Two earlier versions
 * of this got it wrong in opposite directions, and both were caught by CI rather
 * than by reading the code.
 *
 * The first wrote the probe to `os.tmpdir()`, where flat config replies
 * `File ignored because outside of base path` — a *warning*, with `ruleId: null`,
 * which the `@stylistic/` filter below then discarded. Every fixture came back
 * clean and all seven tests passed while checking nothing.
 *
 * The second moved it to the repo root, which fixed the ignoring and introduced
 * a RACE: `nx run-many` runs `@mnci/cli:test` and `@mnci/source:lint`
 * concurrently, so the root lint enumerated the probe file and then hit
 * `ENOENT: ... mnci-fixture-probe-<uuid>.ts` when this test deleted it. A test
 * that writes into the repo it is testing can always do that.
 *
 * `--stdin` with `--stdin-filename` takes the source on stdin and a path that
 * need not exist, so the config resolves exactly as it would for a real file
 * there while nothing is ever written. (The in-process `ESLint#lintText` API
 * would be neater still, but flat config loads `eslint.config.mjs` through a
 * dynamic `import()`, which Jest's CJS VM refuses without
 * `--experimental-vm-modules`.)
 *
 * **Scope, stated honestly.** The virtual path is the repo root, so the
 * type-aware block (scoped to project source directories), import resolution
 * and the Nx dependency checks do not apply. Only the `mnci/standard` block's
 * stylistic rules are asserted — exactly the class that has broken twice, since
 * those are the rules a config change flips wholesale.
 *
 * @param contents - The fixture source.
 * @returns The stylistic rule ids reported, with their messages.
 * @throws Error when ESLint did not actually lint the fixture.
 * @typeParam None - this function has no generic type parameters.
 */
function stylisticProblems (contents: string): string[] {
  let raw: string
  try {
    raw = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js'),
        '--stdin',
        // A path that need not exist. The config resolves exactly as it would
        // for a real file here, and nothing is written.
        '--stdin-filename',
        join(REPO_ROOT, 'e2e-fixture-probe.ts'),
        '--no-config-lookup',
        '--config',
        join(REPO_ROOT, 'eslint.config.mjs'),
        '--format',
        'json'
      ],
      { cwd: REPO_ROOT, input: contents, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    )
  } catch (error) {
    // ESLint exits non-zero whenever it reports anything; the JSON is still on
    // stdout, and that is the payload this assertion is about.
    raw = (error as { stdout?: string }).stdout ?? '[]'
  }
  const results = JSON.parse(raw) as LintResult[]
  assertActuallyLinted(results)
  return results
    .flatMap(result => result.messages)
    .filter(message => message.ruleId?.startsWith('@stylistic/'))
    .map(message => `${message.ruleId}: ${message.message}`)
}

/**
 * Fails when ESLint skipped the fixture instead of linting it.
 *
 * @remarks
 * A skipped file and a clean file are indistinguishable once the messages are
 * filtered to `@stylistic/` — both are an empty list. This is what makes the
 * difference visible, and it exists because the first version of this guard was
 * silently in the skipped case for every fixture while reporting all green.
 *
 * @param results - ESLint's results for the fixture.
 * @returns Nothing.
 * @throws Error when nothing was linted, or the fixture was ignored or unparsed.
 * @typeParam None - this function has no generic type parameters.
 */
function assertActuallyLinted (results: LintResult[]): void {
  if (results.length === 0) {
    throw new Error('ESLint returned no results — the fixture was never linted.')
  }
  const skipped = results
    .flatMap(result => result.messages)
    .find(
      message =>
        message.ruleId === null &&
        /ignored|outside of base path|Parsing error/i.test(message.message)
    )
  if (skipped) {
    throw new Error(`ESLint did not lint the fixture: ${skipped.message}`)
  }
}

describe("the e2e's own TypeScript fixtures satisfy the shipped Standard block", () => {
  const fixtures = [...markedFixtures()]

  it('finds the marked fixtures, so an extraction break cannot pass silently', () => {
    // Without this the suite degrades to zero test cases the moment the marker
    // or the `writeFileSync` shape changes — green, and checking nothing. That
    // is not a hypothetical failure mode here: an earlier version of this file
    // passed all seven of its tests while linting a path ESLint was ignoring.
    expect(fixtures.map(([target]) => target)).toEqual(
      expect.arrayContaining(['apps/api/src/deps.ts', 'apps/api/src/main.ts'])
    )
  })

  it.each(fixtures)('%s is Standard-clean', (target, contents) => {
    expect({ target, problems: stylisticProblems(contents) }).toEqual({ target, problems: [] })
  })
})
