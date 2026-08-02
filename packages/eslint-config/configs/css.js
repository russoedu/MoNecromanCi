import css from '@eslint/css'

/** CSS, via ESLint's own official CSS language plugin. */
export default [
  {
    name: 'mnci/css',
    files: ['**/*.css'],
    plugins: { css },
    language: 'css/css',
    rules: {
      'css/no-empty-blocks': 'error',
      'css/no-duplicate-imports': 'error',
      'css/no-invalid-at-rules': 'error',
      'css/no-invalid-properties': 'error'
    }
  }
]
