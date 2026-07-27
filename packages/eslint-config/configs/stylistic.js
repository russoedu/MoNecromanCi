import stylistic from '@stylistic/eslint-plugin'

/**
 * The JavaScript Standard Style rules Prettier genuinely leaves open.
 *
 * Prettier owns all formatting in an mnci workspace and covers the bulk of
 * Standard: no semicolons, single quotes, 2-space indent, no trailing commas.
 * This block adds back only the Standard rules Prettier never touches, so it
 * can be composed AFTER `eslint-config-prettier` without contradicting it.
 *
 * The list was derived empirically, not guessed: every stylistic rule in
 * `eslint-config-standard` was checked against `eslint-config-prettier`'s
 * disable list, and these three are exactly the ones it does not switch off.
 *
 * ## Why `space-before-function-paren` is NOT here
 *
 * It is Standard's most recognisable rule, and the obvious thing to reach for.
 * It cannot work. `eslint-config-prettier` disables it because it *conflicts*
 * with Prettier rather than because it is redundant: Prettier emits
 * `function f(a)` and will rewrite `function f (a)` back on every run, while
 * the rule demands the opposite. Enabling it makes `npm run lint` and
 * `npm run format:check` mutually unsatisfiable — verified by round-tripping a
 * real file through both binaries. Prettier has closed the corresponding
 * option permanently, so this is not a version-skew issue that will resolve.
 *
 * Choosing Prettier as the formatter means accepting its call here. mnci does,
 * and says so plainly in the README rather than shipping a config whose two
 * quality gates fight each other.
 */
export default [
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    plugins: { '@stylistic': stylistic },
    rules: {
      // `//comment` → `// comment`. Prettier never edits comment bodies.
      '@stylistic/spaced-comment': [
        'error',
        'always',
        {
          line: { markers: ['*package', '!', '/', ',', '='] },
          block: {
            balanced: true,
            markers: ['*package', '!', ',', ':', '::', 'flow-include'],
            exceptions: ['*'],
          },
        },
      ],
      // Prettier preserves whatever blank lines are (or are not) between class
      // members; Standard requires one, except after a single-line member.
      '@stylistic/lines-between-class-members': [
        'error',
        'always',
        { exceptAfterSingleLine: true },
      ],
      // A byte-order mark survives Prettier untouched and breaks shebangs,
      // diffs, and some parsers. Still a core ESLint rule — `@stylistic` never
      // adopted this one, so it carries no plugin prefix.
      'unicode-bom': ['error', 'never'],
    },
  },
]
