import canonicalConfig from './assets/eslint.config.mjs'

export default [
  ...canonicalConfig,
  // Vendored template copied verbatim into generated repos — not this project's own style.
  { ignores: ['assets/**'] },
  {
    files: ['**/*.{ts,mts,cts}', '**/*.{js,mjs,cjs}'],
    rules: {
      'unicorn/filename-case':       ['error', { cases: { camelCase: true, pascalCase: true }, ignore: [/^_.+\.[jt]s$/, /^[a-z][\w-]*\.config\.[jt]s$/] }],
      // Codebase-wide convention is named imports from node:path; allow alongside the rule's default.
      // (The rule strips the `node:` prefix before matching, so the style key is bare `path`.)
      'unicorn/import-style':        ['error', { styles: { path: { named: true } } }],
      // We intentionally emit ${...} literals (VSCode launch vars, npm authToken).
      'no-template-curly-in-string': 'off',
    },
  },
]
