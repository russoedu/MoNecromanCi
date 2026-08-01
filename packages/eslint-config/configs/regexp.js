import regexp from 'eslint-plugin-regexp'

/**
 * Rules that crash rather than report when the TypeScript parser is present
 * without type-aware services — see this module's remarks.
 */
const NEEDS_TYPE_SERVICES = [
  'regexp/no-legacy-features',
  'regexp/no-missing-g-flag',
  'regexp/no-useless-dollar-replacements',
  'regexp/no-useless-flag',
]

/**
 * Regular-expression correctness.
 *
 * @remarks
 * `flat/recommended` (67 rules) minus the four listed in
 * {@link NEEDS_TYPE_SERVICES}. Measured against this monorepo before being
 * adopted: it reported three problems, all real — capturing groups that are never
 * read, which should be non-capturing `(?:…)`.
 *
 * The rules worth having are the ones that report nothing on clean code.
 * `no-super-linear-backtracking` and `no-super-linear-move` catch catastrophic
 * backtracking, where a regex is correct but takes exponential time on a crafted
 * input — a real denial-of-service in anything matching user data, and invisible to
 * review. `no-empty-alternative` and `no-useless-assertions` catch branches that can
 * never match, which is almost always a typo in an escape. That is squarely inside
 * this config's correctness-only scope: a regex that cannot match what its author
 * meant is a bug, and Prettier has no opinion about regex internals.
 *
 * **Why four rules are off, and why it is a crash rather than a preference.** Each
 * of them opportunistically reaches for TypeScript type information and throws when
 * the TS parser is present but its type-aware services are not:
 *
 * ```
 * TypeError: Error while loading rule 'regexp/no-missing-g-flag':
 * Cannot read properties of undefined (reading 'esTreeNodeToTSNodeMap')
 * ```
 *
 * That combination is the normal case here, not an exotic one:
 * `configs/typescript.js` gives every `.ts` file the TS parser, while
 * `configs/typeAware.js` adds `projectService` only under
 * `{apps,libs,packages}/<name>/src`. So any TypeScript outside a project's source — a
 * root `*.config.ts`, a package's `tests/` directory — hits it, and a crash takes
 * down linting for that entire file instead of reporting one problem. It fired in
 * all four packages of this monorepo.
 *
 * Switching them off globally is deliberate, rather than narrowing this block to
 * the files that do have services. Narrowing would keep all 67 rules but couple
 * this module's scope to `typeAware.js`'s, so a future change there would silently
 * disable regex linting somewhere; and it would leave root-level `.ts` files with
 * no regex checking at all. Losing four type-dependent conveniences everywhere is
 * the better trade — none of them is a safety rule, and the backtracking rules that
 * justify this plugin do not need types.
 *
 * Found by running the composed config on a real repository. An isolated test of
 * the preset passes, because in isolation there are no parser services to be
 * missing — which is exactly why this needed the real thing to surface.
 */
export default [
  regexp.configs['flat/recommended'],
  { rules: Object.fromEntries(NEEDS_TYPE_SERVICES.map(rule => [rule, 'off'])) },
]
