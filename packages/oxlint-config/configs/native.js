/**
 * The rules oxlint implements in Rust, mirroring `@mnci/eslint-config`.
 *
 * @remarks
 * Every entry is one the ESLint config enables, translated to oxlint's rule
 * name and carrying the ESLint options **verbatim** — options are not cosmetic
 * here. Dropping them was measured to change behaviour: a probe that passed a
 * bare `'error'` where the ESLint config passes
 * `['error', { checkArrowFunctions: true }]` reported a finding on
 * ESLint-clean source.
 *
 * The plugin-name translation is oxlint's own: `@typescript-eslint/x` becomes
 * `typescript/x`, `import-x/x` becomes `import/x`, `n/x` becomes `node/x`. Some
 * `@typescript-eslint` rules that extend a core rule land under the core name,
 * which is why a few entries here carry no prefix at all.
 *
 * These run on the fast path. What oxlint has no Rust implementation for is in
 * `bridged.js` instead, running the real ESLint plugin through oxlint's JS
 * plugin bridge.
 */
export default {
  'typescript/await-thenable': 'error',
  'typescript/ban-ts-comment': 'error',
  'typescript/consistent-type-imports': [
    'error',
    { prefer: 'type-imports', fixStyle: 'separate-type-imports' }
  ],
  'typescript/explicit-function-return-type': [
    'error',
    { allowExpressions: true, allowTypedFunctionExpressions: true }
  ],
  'no-array-constructor': 'error',
  'typescript/no-array-delete': 'error',
  'typescript/no-duplicate-enum-values': 'error',
  'typescript/no-duplicate-type-constituents': 'error',
  'typescript/no-empty-object-type': 'error',
  'typescript/no-explicit-any': 'error',
  'typescript/no-extra-non-null-assertion': 'error',
  'typescript/no-floating-promises': 'error',
  'typescript/no-for-in-array': 'error',
  'typescript/no-implied-eval': 'error',
  'typescript/no-misused-new': 'error',
  'typescript/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
  'typescript/no-namespace': 'error',
  'typescript/no-non-null-asserted-optional-chain': 'error',
  'typescript/no-non-null-assertion': 'error',
  'typescript/no-require-imports': 'error',
  'typescript/no-this-alias': 'error',
  'typescript/no-unnecessary-type-assertion': 'error',
  'typescript/no-unnecessary-type-constraint': 'error',
  'typescript/no-unsafe-declaration-merging': 'error',
  'typescript/no-unsafe-function-type': 'error',
  'no-unused-expressions': [
    'error',
    { allowShortCircuit: false, allowTaggedTemplates: false, allowTernary: false }
  ],
  'typescript/no-wrapper-object-types': 'error',
  'typescript/prefer-as-const': 'error',
  'typescript/prefer-namespace-keyword': 'error',
  'typescript/triple-slash-reference': 'error',
  'typescript/unbound-method': 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'for-direction': 'error',
  'import/no-cycle': 'error',
  'import/no-self-import': 'error',
  'node/handle-callback-err': ['error', '^(err|error)$'],
  'node/no-exports-assign': 'error',
  'no-async-promise-executor': 'error',
  'no-case-declarations': 'error',
  'no-compare-neg-zero': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-binary-expression': ['error', { checkRelationalComparisons: false }],
  'no-constant-condition': ['error', { checkLoops: 'allExceptWhileTrue' }],
  'no-control-regex': 'error',
  'no-debugger': 'error',
  'no-delete-var': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-empty': ['error', { allowEmptyCatch: false }],
  'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: false }],
  'no-empty-static-block': 'error',
  'no-ex-assign': 'error',
  'no-extra-boolean-cast': ['error', {}],
  'no-fallthrough': ['error', { allowEmptyCase: false, reportUnusedFallthroughComment: false }],
  'no-global-assign': ['error', { exceptions: [] }],
  'no-irregular-whitespace': [
    'error',
    {
      skipComments: false,
      skipJSXText: false,
      skipRegExps: false,
      skipStrings: true,
      skipTemplates: false
    }
  ],
  'no-loss-of-precision': 'error',
  'no-misleading-character-class': ['error', { allowEscape: false }],
  'no-nonoctal-decimal-escape': 'error',
  'no-prototype-builtins': 'error',
  'no-regex-spaces': 'error',
  'no-self-assign': ['error', { props: true }],
  'no-shadow-restricted-names': ['error', { reportGlobalThis: true }],
  'no-sparse-arrays': 'error',
  'no-throw-literal': 'error',
  'no-unassigned-vars': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-optional-chaining': ['error', { disallowArithmeticOperators: false }],
  'no-unused-labels': 'error',
  'no-unused-private-class-members': 'error',
  'no-useless-catch': 'error',
  'no-useless-escape': ['error', { allowRegexCharacters: [] }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all', ignoreReadBeforeAssign: false }],
  'prefer-promise-reject-errors': ['error', { allowEmptyReject: false }],
  'prefer-rest-params': 'error',
  'prefer-spread': 'error',
  // The one rule whose options are NOT carried verbatim, and the reason is a
  // hard failure rather than a preference: oxlint's implementation accepts
  // only `requireCatchParameter`, so passing ESLint's `errorClassNames: []`
  // alongside it makes oxlint reject the whole config file — every rule in it,
  // not just this one. The meaningful half is kept; `errorClassNames: []` is
  // ESLint's own default, so nothing is lost. Found by iterating the real
  // binary over all 431 rules, which reported exactly this one.
  'preserve-caught-error': ['error', { requireCatchParameter: false }],
  'promise/no-new-statics': 'error',
  'promise/no-return-wrap': 'error',
  'promise/param-names': 'error',
  'promise/valid-params': 'error',
  'require-yield': 'error',
  'unicode-bom': ['error', 'never'],
  'use-isnan': ['error', { enforceForIndexOf: false, enforceForSwitchCase: true }],
  'valid-typeof': ['error', { requireStringLiterals: false }]
}
