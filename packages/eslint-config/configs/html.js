import html from '@html-eslint/eslint-plugin'
import htmlParser from '@html-eslint/parser'

/**
 * HTML correctness and accessibility.
 *
 * Only non-stylistic rules: `@html-eslint` ships an `indent`/`quotes` family
 * that would fight Prettier, which formats HTML natively.
 */
export default [
  {
    name: 'mnci/html',
    files: ['**/*.html'],
    languageOptions: { parser: htmlParser },
    plugins: { '@html-eslint': html },
    rules: {
      '@html-eslint/no-duplicate-id': 'error',
      '@html-eslint/no-duplicate-attrs': 'error',
      '@html-eslint/require-img-alt': 'error',
      '@html-eslint/require-lang': 'error',
      '@html-eslint/no-obsolete-tags': 'error',
      '@html-eslint/require-doctype': 'error'
    }
  }
]
