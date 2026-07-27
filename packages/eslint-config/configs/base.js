import js from '@eslint/js'
import n from 'eslint-plugin-n'
import promise from 'eslint-plugin-promise'
import unicorn from 'eslint-plugin-unicorn'
import unusedImports from 'eslint-plugin-unused-imports'
import globals from 'globals'

/**
 * Correctness and code-quality rules for every JS/TS file.
 *
 * Deliberately contains NO stylistic rules: formatting is Prettier's job, and
 * `stylistic.js` carries only the few Standard rules Prettier cannot express.
 */
export default [
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2024 },
    },
    plugins: { n, promise, unicorn, 'unused-imports': unusedImports },
    rules: {
      ...js.configs.recommended.rules,

      // Standard's correctness core.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-console': 'off',
      'no-return-await': 'error',
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',

      // Unused imports/vars: the plugin removes imports on --fix, which the
      // base rule cannot do. The base rule is disabled so they do not double-report.
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' },
      ],

      // Promise correctness — a frequent source of silent bugs.
      'promise/no-return-wrap': 'error',
      'promise/param-names': 'error',
      'promise/no-new-statics': 'error',
      'promise/valid-params': 'error',

      // Node correctness, minus the resolver rules that fight bundlers and
      // TS path aliases (they false-positive on workspace imports).
      'n/no-deprecated-api': 'error',
      'n/handle-callback-err': ['error', '^(err|error)$'],
      'n/no-exports-assign': 'error',
      'n/prefer-node-protocol': 'error',

      // Unicorn, minus the opinionated-naming and stylistic members.
      ...unicorn.configs.recommended.rules,
      'unicorn/filename-case': 'off',
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-null': 'off',
      'unicorn/prefer-top-level-await': 'off',
      'unicorn/no-array-reduce': 'off',
      // Nx's own generators emit files with a bare `/* eslint-disable */`
      // (e.g. the jest.config.cts they write for every project). Those files
      // are not ours to edit, and a rule that makes a freshly generated
      // workspace fail `npm run lint` out of the box is worse than the
      // blanket disables it is trying to catch.
      'unicorn/no-abusive-eslint-disable': 'off',
    },
  },
]
