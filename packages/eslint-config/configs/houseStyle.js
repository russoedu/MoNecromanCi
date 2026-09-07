import stylistic from '@stylistic/eslint-plugin'

/**
 * mnci's deliberate departures from JavaScript Standard Style.
 *
 * @remarks
 * A separate block, composed **after** `mnci/standard`, rather than edits made
 * inside it. That block is a faithful, programmatically extracted port of
 * `neostandard`, and its docblock says so; editing it in place would make that
 * claim false and would silently revert these choices the next time anyone
 * re-extracts from upstream. Keeping the departures here means the port stays a
 * port, and every difference from Standard is in one file with a reason
 * attached.
 *
 * Named, like every other block, because the name is what
 * `eslint --inspect-config` reports and what a user's own override targets.
 *
 * Each rule below is a decision, not a default:
 *
 * - **Trailing commas come back**, as `always-multiline`. Standard forbids them
 *   outright and `mnci/standard` therefore sets `never` in all eight contexts.
 *   The trade is a real one: a trailing comma keeps a one-line diff to one line
 *   when an item is appended, which is most of why it is wanted. `never` is not
 *   wrong — this is a preference overriding it, which is exactly why it lives
 *   in a block that says so out loud rather than being edited into the port.
 *
 * - **Object values are aligned.** `key-spacing` gains `align: { on: 'value' }`,
 *   and that alone is not enough: aligning requires more than one space before
 *   the value, which `no-multi-spaces` rejects. Both rules have to move
 *   together or the config contradicts itself — one reports what the other
 *   demands, and no `--fix` can satisfy both. That is the single most important
 *   thing to know before touching either of them.
 *
 * - **`no-multi-spaces` gains three exceptions** beyond @stylistic's own
 *   defaults (`Property`, `ImportAttribute`, which are re-listed because
 *   supplying `exceptions` REPLACES the default object rather than merging into
 *   it — omitting them would switch off alignment inside object literals, the
 *   very place it is most wanted). `VariableDeclarator` permits aligned `=`,
 *   `BinaryExpression` aligned operators, `TSTypeAnnotation` aligned types.
 *
 * - **`quote-props` is `consistent-as-needed`, not `as-needed`.** Quotes are
 *   still dropped where no key needs them, but the moment one key does, they
 *   all take them. `as-needed` produces the mixed form — one quoted key beside
 *   five bare ones — which reads as an accident.
 *
 * - **A blank line is required before `return`.** Written as
 *   `padding-line-between-statements` rather than `newline-before-return`,
 *   which is the rule most people reach for and which is a trap: it has been
 *   deprecated since ESLint 4 and its metadata says `availableUntil: "11.0.0"`,
 *   so depending on it now buys a breakage at the next major. The two were
 *   compared on the same fixture and report identically — including the case
 *   that matters, a `return` that is the only statement in its block, which
 *   neither flags.
 *
 * - **Two statements per line are allowed.** @stylistic's default is one.
 *   `max: 2` permits the short guard-and-return idiom without opening the door
 *   to genuinely dense lines.
 *
 * @typeParam None - this module has no generic type parameters.
 */
export default [
  {
    name:    'mnci/house-style',
    files:   ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    plugins: { '@stylistic': stylistic },
    rules:   {
      '@stylistic/comma-dangle': ['error', {
        arrays:    'always-multiline',
        objects:   'always-multiline',
        imports:   'always-multiline',
        exports:   'always-multiline',
        functions: 'always-multiline',
        // The TypeScript-only contexts are listed for the same reason
        // `mnci/standard` lists them: @stylistic's defaults for them are not
        // the value we want, so omitting them leaves the setting inconsistent
        // in exactly the places a TS codebase writes.
        enums:     'always-multiline',
        generics:  'always-multiline',
        tuples:    'always-multiline',
      }],
      '@stylistic/key-spacing': ['error', {
        align: { beforeColon: false, afterColon: true, on: 'value' },
      }],
      '@stylistic/max-statements-per-line': ['error', { max: 2 }],
      '@stylistic/no-multi-spaces':         ['error', {
        ignoreEOLComments: true,
        exceptions:        {
          Property:           true,
          ImportAttribute:    true,
          VariableDeclarator: true,
          BinaryExpression:   true,
          TSTypeAnnotation:   true,
        },
      }],
      '@stylistic/padding-line-between-statements': ['error', {
        blankLine: 'always',
        prev:      '*',
        next:      'return',
      }],
      '@stylistic/quote-props': ['error', 'consistent-as-needed'],
    },
  },
]
