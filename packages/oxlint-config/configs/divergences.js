/**
 * Rules switched off because oxlint and ESLint genuinely disagree about them.
 *
 * @remarks
 * This package's one hard promise is **anything `@mnci/eslint-config` accepts
 * must pass oxlint**. A rule that reports on code the ESLint stack lints clean
 * breaks that promise, and the fix is to switch the rule off here with the
 * evidence attached — never to leave it on and let a workspace fail lint on a
 * file its own ESLint config approves of.
 *
 * The direction matters and is worth being precise about. This package is
 * allowed to be *more permissive* than the ESLint config — 246 of its rules do
 * not exist in oxlint at all, so it inevitably is. It is never allowed to be
 * *stricter*, because that is the case where a passing codebase starts failing.
 *
 * Each entry is a measured divergence, not a preference. `tests/parity.spec.ts`
 * is what finds them: it lints fixtures the ESLint config accepts and requires
 * zero findings.
 */
export default {
  // Reports `Move arrow function 'label' to the outer scope.` on
  // `packages/cli/src/commands/add/shared.ts:397` — a file ESLint exits 0 on
  // with this same rule enabled and the same options
  // (`{ checkArrowFunctions: true }`). Confirmed against both the repo's own
  // root config and a bare `mnci()` config, so it is not a local-config effect.
  //
  // Two hypotheses were tested and both were wrong, which is why they are
  // written down rather than left for someone to retry:
  //
  //  1. *Dropped options.* It survives carrying the ESLint options through
  //     verbatim. Not the cause, though it WAS a real bug found on the way.
  //  2. *A minimal reproduction.* The obvious three-line version
  //     (`const label = row => row.label ?? ''; return rows.map(label)`) is
  //     reported by **both** linters, so it is not a divergence at all. The
  //     behaviour depends on the surrounding file, and it only appears on the
  //     full 400-line module. That is also why `tests/parity.spec.ts` carries
  //     no fixture for this entry — a fake one asserted the opposite of the
  //     truth, which is worse than no fixture.
  //
  // oxlint's JS plugin support is alpha and explicitly outside semver, so a
  // scope-analysis difference between the two hosts is the likely cause.
  //
  // Off rather than narrowed, because the failure mode is the worst available:
  // a workspace that lints clean under ESLint would fail under oxlint on a file
  // nobody touched. Re-enable it once the bridge stops disagreeing.
  'unicorn-js/consistent-function-scoping': 'off',

  // Reports on `packages/nx-flutter/src/internal/workspace.ts`, which ESLint
  // lints clean with this rule enabled.
  //
  // Here the cause is identifiable rather than a guess: `@mnci/eslint-config`
  // enables it as `['error', { allowExpressionStatement: true }]`, that option is
  // carried through verbatim, and the reported code IS an expression statement.
  // So ESLint honours the option and the bridge does not appear to.
  //
  // Worth contrasting with the entry above, because the two are different risks:
  // that one is a whole-rule behavioural difference, this one is an **option**
  // being ignored. The second kind is the more dangerous of the two, since a rule
  // whose options do not apply is stricter than configured everywhere it runs,
  // not just in one file. If a third of these turns up, stop switching rules off
  // one at a time and treat option fidelity through the bridge as the bug.
  'unicorn-js/no-array-sort': 'off'
}
