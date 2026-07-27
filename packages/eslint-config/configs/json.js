import jsonc from 'eslint-plugin-jsonc'
// Namespace import: the package exposes `parseForESLint` as a named export and
// provides no ESM default, which is exactly the shape ESLint wants a parser in.
import * as jsoncParser from 'jsonc-eslint-parser'

/**
 * JSON, JSONC and JSON5.
 *
 * `eslint-plugin-jsonc` covers all three dialects with one parser, which is
 * also the parser `@nx/dependency-checks` requires — so this deliberately does
 * NOT add `@eslint/json`, which would register a competing language for the
 * same files.
 */
export default [
  {
    files: ['**/*.json'],
    languageOptions: { parser: jsoncParser },
    plugins: { jsonc },
    rules: {
      ...jsonc.configs['flat/recommended-with-json'].at(-1).rules,
    },
  },
  {
    files: ['**/*.jsonc', '**/tsconfig*.json', '**/*.code-workspace'],
    languageOptions: { parser: jsoncParser },
    plugins: { jsonc },
    rules: {
      ...jsonc.configs['flat/recommended-with-jsonc'].at(-1).rules,
    },
  },
  {
    files: ['**/*.json5'],
    languageOptions: { parser: jsoncParser },
    plugins: { jsonc },
    rules: {
      ...jsonc.configs['flat/recommended-with-json5'].at(-1).rules,
    },
  },
]
