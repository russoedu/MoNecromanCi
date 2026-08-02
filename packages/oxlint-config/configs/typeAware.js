/**
 * The rules that read **types**, mirroring `@mnci/eslint-config`'s
 * `mnci/type-aware` block.
 *
 * @remarks
 * These are the rules nothing else in the stack can replace — most importantly
 * `no-floating-promises`, which catches a dropped `await` that `tsc`, the
 * formatter and every other rule are silent about.
 *
 * **They require `oxlint --type-aware`, and are inert without it.** That flag
 * shells out to `oxlint-tsgolint`, which is why it is a dependency of this
 * package rather than something a workspace has to discover: verified that
 * without it oxlint fails outright with `Failed to find tsgolint executable`,
 * which is at least a loud failure rather than a quiet one.
 *
 * The curated list is the ESLint config's, for the same reason recorded there:
 * `recommendedTypeChecked` reported 67 problems on this monorepo and most were
 * not bugs. Only the subset oxlint implements appears here — `unbound-method`
 * among others has no oxlint equivalent, so it is one of the 246 rules this
 * package cannot carry over.
 *
 * `no-misused-promises` keeps the ESLint config's `checksVoidReturn.attributes:
 * false`. That is not tuning: an async JSX event handler
 * (`onClick={async () => { await save() }}`) is the universal React idiom, and
 * the default setting fails a freshly generated `react-app` on a file the user
 * wrote normally.
 */
export default {
  'typescript/no-floating-promises': 'error',
  'typescript/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
  'typescript/await-thenable': 'error',
  'typescript/no-unnecessary-type-assertion': 'error',
  'typescript/no-array-delete': 'error',
  'typescript/no-for-in-array': 'error',
  'typescript/no-implied-eval': 'error',
  'typescript/no-duplicate-type-constituents': 'error'
}
