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
      ...jsonc.configs['flat/recommended-with-json'].at(-1).rules
    }
  },
  {
    files: ['**/*.jsonc', '**/tsconfig*.json', '**/*.code-workspace', '**/.vscode/*.json'],
    languageOptions: { parser: jsoncParser },
    plugins: { jsonc },
    rules: {
      ...jsonc.configs['flat/recommended-with-jsonc'].at(-1).rules,

      // Explicitly, because spreading the JSONC preset is NOT enough to undo the
      // strict-JSON block above. These files also match `**/*.json`, which enables
      // `jsonc/no-comments`, and the JSONC preset simply omits that rule rather
      // than setting it to 'off' — so in flat config the earlier 'error' survives
      // and a commented tsconfig.json fails lint. Which it did: a commented
      // `tsconfig.json` reported 8 `jsonc/no-comments` errors, even though these
      // files were already listed here as JSONC. TypeScript and VS Code both read
      // comments in them, so forbidding comments was simply wrong.
      'jsonc/no-comments': 'off'
    }
  },
  {
    files: ['**/*.json5'],
    languageOptions: { parser: jsoncParser },
    plugins: { jsonc },
    rules: {
      ...jsonc.configs['flat/recommended-with-json5'].at(-1).rules
    }
  }
]
