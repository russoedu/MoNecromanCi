/**
 * The mnci formatting opinion: **JavaScript Standard Style**, as Prettier options.
 *
 * @remarks
 * This lives in the same package as the ESLint rules on purpose. Linting and
 * formatting are one decision, not two — `eslint-config-prettier` is composed
 * last in `index.js` precisely so that every formatting rule defers to these
 * settings, and splitting them across two packages means a version pair that can
 * drift into `npm run lint` and `npm run format:check` disagreeing.
 *
 * Consuming it as a shareable config also means a formatting fix reaches an
 * existing workspace through `npm update`, exactly like a rule change does,
 * rather than needing `mnci upgrade` to rewrite a file.
 *
 * Each option below is a JavaScript Standard Style rule, not a preference:
 *
 * - `semi: false` — Standard omits semicolons.
 * - `singleQuote: true` — Standard uses single quotes.
 * - `trailingComma: 'none'` — Standard forbids trailing commas. (Prettier's own
 *   default is `'all'`, so this must be stated.)
 * - `arrowParens: 'avoid'` — `x => x`, not `(x) => x`.
 * - `printWidth: 100` — wider than Prettier's 80, narrow enough to review in a
 *   split pane.
 * - `tabWidth: 2` / `useTabs: false` — two spaces.
 *
 * One rule is NOT expressible here and is enforced from the ESLint side instead:
 * `space-before-function-paren`. Standard wants `function f (a)`, Prettier writes
 * `function f(a)`, and `eslint-config-prettier` switches the rule off because the
 * two genuinely conflict. Enabling it would make lint and format:check mutually
 * unsatisfiable — see `configs/stylistic.js`.
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
