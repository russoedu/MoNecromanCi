/**
 * Rules switched off for TypeScript declaration files.
 *
 * @remarks
 * Mirrors two blocks in `@mnci/eslint-config` — `mnci/typescript/declarations`
 * and `mnci/type-aware/declarations` — and exists for the same reason the React
 * block's one `'off'` entry does: a `.d.ts` matches `**\/*.{ts,mts,cts,tsx}`, so
 * every rule the TS override enables applies to it unless something takes it
 * back off.
 *
 * Why each one has nothing to say about a declaration file:
 *
 * - `no-explicit-any` / `consistent-type-imports` — vendor declarations
 *   legitimately re-declare types and use `any`; the file is describing someone
 *   else's API, not choosing how to write it.
 * - `no-floating-promises` / `no-misused-promises` — nothing in a `.d.ts`
 *   executes, so there is no promise to float.
 * - `unbound-method` — misreads an interface's method signatures as unbound
 *   uses, which is what a signature IS.
 *
 * Found by enumerating every scoped `'off'` in the ESLint config and checking
 * each against this one, not by tripping over it: a generated workspace has no
 * `.d.ts` of its own, so this would have stayed broken until the first user
 * added a vendor declaration. `tests/parity.spec.ts` keeps the two in step.
 */
export const DECLARATION_FILES = ['**/*.d.ts', '**/*.d.mts', '**/*.d.cts']

export default {
  'typescript/no-explicit-any': 'off',
  'typescript/consistent-type-imports': 'off',
  'typescript/no-floating-promises': 'off',
  'typescript/no-misused-promises': 'off',
  'typescript/unbound-method': 'off'
}
