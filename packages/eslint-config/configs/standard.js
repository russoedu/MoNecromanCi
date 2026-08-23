import stylistic from '@stylistic/eslint-plugin'

/**
 * JavaScript Standard Style, as ESLint rules — the whole formatting opinion.
 *
 * @remarks
 * This block is why the workspace needs no formatter. ESLint is the single
 * tool: code quality, type awareness and formatting, one config, one command,
 * one set of squiggles in the editor. There is nothing to keep in sync,
 * because there is only one opinion.
 *
 * **`eslint-config-prettier` is gone, and its removal is what makes this work.**
 * That package exists to switch every stylistic rule OFF so a formatter can own
 * them. Composing it after this block would disable all 62 rules below and
 * leave the workspace with no style enforcement whatsoever — silently, since a
 * disabled rule reports nothing.
 *
 * **`space-before-function-paren` is ON**, and that is the headline change.
 * Standard's most recognisable rule was unreachable for as long as a
 * Prettier-compatible formatter owned formatting: Prettier and oxfmt both emit
 * `function f(a)` and rewrite `function f (a)` back on every run, so enabling
 * the rule made `lint` and `format:check` mutually unsatisfiable. With no
 * formatter, nothing contradicts it.
 *
 * ## Where these rules come from
 *
 * Derived from `neostandard` — the standard team's maintained flat-config
 * successor — rather than hand-invented, then ported to `@stylistic` v5 names.
 * Extracted programmatically so no rule or option is mistyped: 61 stylistic
 * rules, of which 60 carry over unchanged and one was renamed
 * (`func-call-spacing` → `function-call-spacing`). `unicode-bom` is added on
 * top, a core rule `@stylistic` never adopted.
 *
 * **neostandard itself is deliberately NOT a dependency, and that was measured
 * rather than assumed.** It pins `@stylistic/eslint-plugin` at exactly `2.11.0`,
 * which calls `sourceCode.isSpaceBetweenTokens` — an API removed in ESLint 10 —
 * so it throws on the first file it lints. Forcing it onto `@stylistic` v5 with
 * an override fails differently: its config references `func-call-spacing`,
 * which v5 no longer has, so the config will not even load. Its `eslint: ^9`
 * peer is accurate, not stale. Re-check on a future release; until then the
 * rule list is worth taking and the package is not.
 *
 * The options matter as much as the rule names — see `@stylistic/indent` and its
 * `offsetTernaryExpressions`. That is exactly the part worth deriving instead of
 * guessing.
 *
 * Three of neostandard's entries were deprecated by `@stylistic` v5 and are
 * adapted rather than copied, since each printed a warning on every lint run:
 *
 * - `quotes`' boolean `allowTemplateLiterals: false` → `'never'`.
 * - `jsx-props-no-multi-spaces` → folded into `no-multi-spaces`, which Standard
 *   already sets, so it is simply dropped.
 * - `jsx-indent` → superseded by `indent`. Dropping it alone would have left JSX
 *   indentation checked by **nothing**, because Standard also lists all sixteen
 *   JSX node types in `indent`'s `ignoredNodes`. Both halves go, so `indent`
 *   genuinely covers JSX. `TemplateLiteral *` stays in `ignoredNodes` — it is
 *   not a JSX node, and removing it makes `indent` false-positive on the
 *   contents of template literals.
 */
export default [
  {
    name: 'mnci/standard',
    files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/array-bracket-spacing': ['error', 'never'],
      '@stylistic/arrow-spacing': ['error', { before: true, after: true }],
      '@stylistic/block-spacing': ['error', 'always'],
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
      // 'never' in every context, and 'error' — Standard forbids trailing commas
      // outright. This shipped as ['warn', { …: 'ignore' }], which is a rule that
      // reports NOTHING: every context ignored, and a warning even if one had not
      // been. The extraction from neostandard picked up a disable layer rather
      // than Standard's own setting, and the e2e caught it on a real
      // `eslint --fix` that left `b: 2,` standing.
      //
      // The TypeScript-only contexts (enums, generics, tuples) are listed too:
      // @stylistic's defaults for them are not 'never', so omitting them would
      // leave trailing commas legal in exactly the places a TS codebase writes.
      '@stylistic/comma-dangle': ['error', { arrays: 'never', objects: 'never', imports: 'never', exports: 'never', functions: 'never', enums: 'never', generics: 'never', tuples: 'never' }],
      '@stylistic/comma-spacing': ['error', { before: false, after: true }],
      '@stylistic/comma-style': ['error', 'last'],
      '@stylistic/computed-property-spacing': ['error', 'never', { enforceForClassMembers: true }],
      '@stylistic/dot-location': ['error', 'property'],
      '@stylistic/eol-last': 'error',
      '@stylistic/function-call-spacing': ['error', 'never'],
      '@stylistic/generator-star-spacing': ['error', { before: true, after: true }],
      '@stylistic/indent': ['error', 2, { SwitchCase: 1, VariableDeclarator: 1, outerIIFEBody: 1, MemberExpression: 1, FunctionDeclaration: { parameters: 1, body: 1 }, FunctionExpression: { parameters: 1, body: 1 }, CallExpression: { arguments: 1 }, ArrayExpression: 1, ObjectExpression: 1, ImportDeclaration: 1, flatTernaryExpressions: false, ignoreComments: false, offsetTernaryExpressions: true, ignoredNodes: ['TemplateLiteral *'] }],
      '@stylistic/jsx-closing-bracket-location': ['error', 'tag-aligned'],
      '@stylistic/jsx-closing-tag-location': 'error',
      '@stylistic/jsx-curly-brace-presence': ['error', { props: 'never', children: 'never' }],
      '@stylistic/jsx-curly-newline': ['error', { multiline: 'consistent', singleline: 'consistent' }],
      '@stylistic/jsx-curly-spacing': ['error', { attributes: { when: 'never', allowMultiline: true }, children: { when: 'never', allowMultiline: true } }],
      '@stylistic/jsx-equals-spacing': ['error', 'never'],
      '@stylistic/jsx-first-prop-new-line': ['error', 'multiline-multiprop'],
      '@stylistic/jsx-indent-props': ['error', 2],
      '@stylistic/jsx-pascal-case': ['error', { allowAllCaps: false }],
      '@stylistic/jsx-quotes': ['error', 'prefer-single'],
      '@stylistic/jsx-tag-spacing': ['error', { closingSlash: 'never', beforeSelfClosing: 'always', afterOpening: 'never', beforeClosing: 'never' }],
      '@stylistic/jsx-wrap-multilines': ['error', { declaration: 'parens-new-line', assignment: 'parens-new-line', return: 'parens-new-line', arrow: 'ignore', condition: 'ignore', logical: 'ignore', prop: 'ignore' }],
      '@stylistic/key-spacing': ['error', { beforeColon: false, afterColon: true }],
      '@stylistic/keyword-spacing': ['error', { before: true, after: true }],
      '@stylistic/lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
      '@stylistic/multiline-ternary': ['error', 'always-multiline'],
      '@stylistic/new-parens': 'error',
      '@stylistic/no-extra-parens': ['error', 'functions'],
      '@stylistic/no-floating-decimal': 'error',
      '@stylistic/no-mixed-operators': ['error', { groups: [['==', '!=', '===', '!==', '>', '>=', '<', '<='], ['&&', '||'], ['in', 'instanceof']], allowSamePrecedence: true }],
      '@stylistic/no-mixed-spaces-and-tabs': 'error',
      '@stylistic/no-multi-spaces': ['error', { ignoreEOLComments: true }],
      '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 0 }],
      '@stylistic/no-tabs': 'error',
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/no-whitespace-before-property': 'error',
      '@stylistic/object-curly-newline': ['error', { multiline: true, consistent: true }],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/object-property-newline': ['error', { allowAllPropertiesOnSameLine: true }],
      '@stylistic/operator-linebreak': ['error', 'after', { overrides: { '?': 'before', ':': 'before', '|>': 'before' } }],
      '@stylistic/padded-blocks': ['error', { blocks: 'never', switches: 'never', classes: 'never' }],
      '@stylistic/quote-props': ['error', 'as-needed'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'never' }],
      '@stylistic/rest-spread-spacing': ['error', 'never'],
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/semi-spacing': ['error', { before: false, after: true }],
      '@stylistic/space-before-blocks': ['error', 'always'],
      '@stylistic/space-before-function-paren': ['error', 'always'],
      '@stylistic/space-in-parens': ['error', 'never'],
      '@stylistic/space-infix-ops': 'error',
      '@stylistic/space-unary-ops': ['error', { words: true, nonwords: false }],
      '@stylistic/spaced-comment': ['error', 'always', { line: { markers: ['*package', '!', '/', ',', '='] }, block: { balanced: true, markers: ['*package', '!', ',', ':', '::', 'flow-include'], exceptions: ['*'] } }],
      '@stylistic/template-curly-spacing': ['error', 'never'],
      '@stylistic/template-tag-spacing': ['error', 'never'],
      '@stylistic/wrap-iife': ['error', 'any', { functionPrototypeMethods: true }],
      '@stylistic/yield-star-spacing': ['error', 'both'],
      'unicode-bom': ['error', 'never']
    }
  }
]
