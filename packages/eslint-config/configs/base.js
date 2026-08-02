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
      // `no-return-await` is deliberately absent. ESLint deprecated it: inside
      // a `try` the `await` is required, and even elsewhere it keeps the frame
      // in async stack traces, which is worth more than the microtask it saves.
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
      // The three v72 additions the v61-era comment here predicted would need
      // switching off, now that the ESLint 10 bump has brought them in. The
      // prediction held: on this repo alone they reported 35, 13 and 19
      // problems, 67 of the 92 the upgrade surfaced, and not one was a defect.
      // The first two rename a team's own vocabulary (`addChoice` must become a
      // function, a boolean must be named `isX`); the third condemns the
      // standard per-test fixture idiom of assigning to a module-level binding
      // from inside `beforeEach`.
      'unicorn/name-replacements': 'off',
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/no-top-level-assignment-in-function': 'off',
      // Reports `{workspaceRoot}` in a plain string as a template literal
      // someone forgot to write `${...}` in. But `{workspaceRoot}` and
      // `{projectRoot}` are **Nx's own interpolation tokens**, the correct
      // content of every target's options — so the rule cannot be right about
      // any code that writes Nx config. Ten findings on this repo, ten false,
      // zero defects: it fails the same "earns its keep" test the rules above
      // fail.
      'unicorn/no-incorrect-template-string-interpolation': 'off',
      'unicorn/filename-case': 'off',
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-null': 'off',
      'unicorn/prefer-top-level-await': 'off',
      'unicorn/no-array-reduce': 'off',
      // Demands `import path from 'node:path'` over `import { join } from
      // 'node:path'`. Named imports are idiomatic, tree-shake better, and are
      // what Nx's own generators emit — this is preference, not correctness.
      'unicorn/import-style': 'off',
      // `document.getElementById('root')` is the canonical React mount, is what
      // every Nx/Vite/CRA template emits, and is faster than the selector form.
      // A rule that fails a generated app on its own entry point is not earning
      // its keep.
      'unicorn/prefer-query-selector': 'off',
      // An Nx monorepo is legitimately mixed CJS/ESM: Nx generates CJS jest
      // configs, executors run under CJS, and `__dirname`/`createRequire` are
      // the correct tools there. The rule cannot tell those apart from real
      // legacy code.
      'unicorn/prefer-module': 'off',
      // Nx's own generators emit files with a bare `/* eslint-disable */`
      // (e.g. the jest.config.cts they write for every project). Those files
      // are not ours to edit, and a rule that makes a freshly generated
      // workspace fail `npm run lint` out of the box is worse than the
      // blanket disables it is trying to catch.
      'unicorn/no-abusive-eslint-disable': 'off',
      // Pure formatting (`10000` vs `10_000`), which puts it outside this
      // config's stated scope — ESLint here is correctness-only, Prettier owns
      // formatting, and Prettier does not touch numeric separators. It is also
      // not a JavaScript Standard Style rule, unlike the three stylistic
      // exceptions in `configs/stylistic.js`, so nothing is lost by dropping it.
      //
      // Concretely: `@nx/react:library --bundler=rollup` emits
      // `url({ limit: 10000 })` in the rollup config it writes, so a freshly
      // added `react-lib`/`react-internal-lib` failed `npm run lint` on its own
      // generated build config — the same "not earning its keep" test the two
      // rules above are off for.
      'unicorn/numeric-separators-style': 'off',
    },
  },
]
