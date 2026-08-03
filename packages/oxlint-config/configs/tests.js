/**
 * Spec-file rules and relaxations, mirroring `@mnci/eslint-config`'s
 * `mnci/tests` block.
 *
 * @remarks
 * Derived by diffing the ESLint config's resolved rules for a `*.test.ts`
 * against ordinary source: {@link ENABLED} is what that block switches on,
 * {@link default} is what it switches off.
 *
 * The relaxations matter more than the additions. Tests legitimately reach for
 * `any` and non-null assertions on fixtures, so without them a spec the ESLint
 * stack accepts would fail oxlint — the one thing this package must never do.
 *
 * **The enabled rules are mirrored onto `vitest/*` as well as `jest/*`**, and
 * that asymmetry is deliberate. `@mnci/eslint-config` covers both stacks with
 * `eslint-plugin-jest` alone, because they share `describe`/`it`/`expect`.
 * oxlint splits them into two plugins, so matching ESLint's *behaviour* on a
 * vitest spec means saying the same thing twice. Everything else those two
 * plugins would enable is switched off in `leaks.js`.
 */
export const TEST_FILES = [
  '**/*.{spec,test}.{js,mjs,cjs,jsx,ts,mts,cts,tsx}',
  '**/jest.*.{js,mjs,cjs,ts,mts,cts}',
  '**/vitest.*.{js,mjs,cjs,ts,mts,cts}',
  '**/test-setup.{js,mjs,cjs,ts,mts,cts}'
]

export const ENABLED = {
  'jest/no-focused-tests': 'error',
  'jest/no-identical-title': 'error',
  'jest/valid-expect': 'error',
  'vitest/no-focused-tests': 'error',
  'vitest/no-identical-title': 'error',
  'vitest/valid-expect': 'error'
}

export default {
  'unicorn-js/no-anonymous-default-export': 'off',
  'unicorn-js/no-useless-undefined': 'off',
  'typescript/no-explicit-any': 'off',
  'typescript/no-non-null-assertion': 'off',
  'typescript/explicit-function-return-type': 'off'
}
