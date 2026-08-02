import tseslint from 'typescript-eslint'

/**
 * The curated type-aware rules — the only rules in this config that can read
 * types, and so the only ones able to catch a whole class of bug nothing else
 * in the stack sees.
 *
 * @remarks
 * **Why a curated list rather than `recommendedTypeChecked`.** That preset was
 * measured against this monorepo first: it reported 67 problems, and the bulk
 * were not bugs. `require-await` fires on every `@mnci/nx-python-pip` executor,
 * which must be `async` to satisfy Nx's executor contract whether or not its body
 * awaits, and `no-unsafe-*` fires throughout the generator specs where Nx devkit
 * hands back loosely typed trees. Enabling it would have meant either rewriting
 * correct code or switching half of it back off — and a rule nobody can satisfy
 * teaches people to reach for `eslint-disable`, which costs more than the rule
 * ever earned. The list below reported **10** problems on the same tree, all of
 * them real.
 *
 * The same "does it earn its keep" test three `unicorn` rules are already off
 * for. What survived it are the rules that catch mistakes a reviewer cannot see
 * and `tsc` does not report:
 *
 * - `no-floating-promises` / `no-misused-promises` — a dropped `await` type-checks
 *   cleanly, passes every test that does not happen to race, and then loses an
 *   error in production. `tsc` is silent on both.
 * - `await-thenable` — the inverse, and usually a sign the author expected an
 *   async API where there is none.
 * - `no-unnecessary-type-assertion` — an `as` that does nothing is either dead
 *   weight or a leftover from a type that has since changed shape, which is worth
 *   knowing.
 * - `unbound-method` — a method passed as a callback silently loses `this`.
 * - `no-array-delete`, `no-for-in-array`, `no-implied-eval`,
 *   `no-duplicate-type-constituents` — narrow, unambiguous, effectively no false
 *   positives.
 *
 * **`projectService: true` is what makes this usable in a generated workspace.**
 * It asks TypeScript to locate each file's own tsconfig instead of being handed
 * an enumerated `project` list. That distinction is the reason this block did not
 * exist before: a scaffold cannot know a workspace's tsconfigs up front, since
 * `mnci add` keeps adding them. `projectService` removes the need to.
 *
 * **Why these rules are scoped to project source directories** rather than every
 * `.ts` file, which is the important safety decision here. A file belonging to no
 * tsconfig is not skipped by the project service — it is a **fatal parsing
 * error**, and a fatal error suppresses every other rule for that file. So the
 * failure is not "one rule went quiet", it is "this file stopped being linted at
 * all" *and* `lint` exits non-zero. In a published config that reaches other
 * people's workspaces, that is the worst available failure mode, and it is
 * exactly the "a fresh workspace fails its own lint" class of bug this project
 * has shipped more than once.
 *
 * Measured, not assumed: applying these rules to `**\/*.ts` made four of this
 * package's own tests report `FATAL`, because its fixture workspace has no
 * tsconfig — a one-line change away from being every consumer's experience.
 *
 * {@link TYPE_AWARE_FILES} instead covers the directories where `mnci add` puts
 * generated projects, all of which get a tsconfig covering their sources and
 * specs. Every real source file is therefore type-aware linted, and a stray
 * script at the workspace root simply keeps the non-type-aware rules rather than
 * breaking the build. Widen this list only alongside a guarantee that the new
 * paths are in a tsconfig.
 *
 * **`allowDefaultProject` is deliberately not used**, though it is the documented
 * escape hatch for stray files, because it fails in *both* directions: a file
 * listed there that some tsconfig *does* cover is also a hard parsing error
 * (`"was included by allowDefaultProject but also was found in the project
 * service"`). A glob broad enough to catch real strays — `*.config.ts` — matched
 * `packages/cli/tsup.config.ts`, which is properly covered, and broke it. The
 * escape hatch traded a rare failure for a common one.
 *
 * Cost, measured rather than assumed: this block takes the whole-repo lint from
 * roughly 5s to 8s, because it builds a real TS program. It therefore also
 * depends on project references being in order — which is already guaranteed,
 * since CI runs `nx sync:check` before it lints.
 */

/**
 * Where type-aware linting applies: the source of a generated project.
 *
 * @remarks
 * `mnci` puts every generated project in `apps/`, `libs/` or `packages/`, and
 * every one of those gets a tsconfig. Restricting the type-aware rules to those
 * trees is what makes a missing tsconfig impossible rather than merely unlikely —
 * see this module's remarks for why that matters more than broader coverage.
 */
export const TYPE_AWARE_FILES = [
  'apps/*/src/**/*.{ts,mts,cts,tsx}',
  'libs/*/src/**/*.{ts,mts,cts,tsx}',
  'packages/*/src/**/*.{ts,mts,cts,tsx}'
]

export default [
  {
    name: 'mnci/type-aware',
    files: TYPE_AWARE_FILES,
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true }
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',

      // `checksVoidReturn.attributes` is off, and only that sub-check. An async
      // JSX event handler — `onClick={async () => { await save() }}` — is the
      // universal React idiom, but React's own prop types declare a void return,
      // so the default setting rejects it. Verified rather than reasoned about: a
      // freshly generated `react-app` with that exact handler failed
      // `npm run lint` on a file the user wrote normally, which is the same defect
      // shape as the `react-lib` rollup config and the vitest dependency-checks
      // bug before it.
      //
      // Every other sub-check stays on, and they are where this rule earns its
      // keep: an async callback passed to `Array.filter`, or an async function
      // used directly in a condition, are real bugs rather than an idiom.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } }
      ],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/unbound-method': 'error',
      '@typescript-eslint/no-array-delete': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/no-duplicate-type-constituents': 'error'
    }
  },
  {
    name: 'mnci/type-aware/declarations',
    // Declaration files describe types rather than execute, so the promise and
    // assertion rules have nothing to say about them, and `unbound-method`
    // misreads an interface's method signatures as unbound uses.
    files: ['**/*.d.ts', '**/*.d.mts', '**/*.d.cts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/unbound-method': 'off'
    }
  }
]
