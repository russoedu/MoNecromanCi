/**
 * The formatting half of this package: JavaScript Standard Style, for oxfmt.
 *
 * @remarks
 * The same seven options `@mnci/eslint-config/prettier` ships, because it is the
 * same opinion — Standard, as a formatter config. oxfmt names every one of them
 * identically to Prettier and even offers `oxfmt --migrate=prettier`, so this is
 * a transcription rather than a translation.
 *
 * **Verified as a Prettier replacement, not assumed to be one.** Measured
 * against the real binaries: byte-identical output on `.json`, `.yaml`, `.md`,
 * `.css` and `.ts` samples, and on 61 of this repo's real already-Prettier-
 * formatted files it diverged on exactly **one** — how a multi-line union after
 * `as` is broken, where oxfmt uses the leading-`|` form and Prettier wraps
 * inline. That divergence is real and switching formatters reformats it, which
 * is the honest cost of the swap rather than a reason to avoid it.
 *
 * Speed is the reason to make the swap at all: 46ms against Prettier's ~1.5s on
 * the same 61 files.
 *
 * Two things this does **not** change, both worth stating because the ESLint
 * config's README makes the same points and they survive the formatter swap:
 *
 * - **Formatting is still not the linter's job.** oxlint here is correctness
 *   only, exactly as ESLint is in the sibling package.
 * - **`space-before-function-paren` still cannot be enforced.** oxfmt emits
 *   `function f(a)` like Prettier does, so a rule demanding `function f (a)`
 *   would make lint and format:check mutually unsatisfiable. Choosing a
 *   Prettier-compatible formatter means accepting that call.
 *
 * oxfmt is **0.61.0 — pre-1.0**, which is the main risk in adopting it and the
 * reason this is a separate export a workspace can decline in favour of
 * `@mnci/eslint-config/prettier`.
 */
export default {
  semi: false,
  singleQuote: true,
  trailingComma: 'none',
  arrowParens: 'avoid',
  printWidth: 100,
  tabWidth: 2,
  useTabs: false
}
