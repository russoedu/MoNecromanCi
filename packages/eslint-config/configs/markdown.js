import markdown from '@eslint/markdown'

/** Markdown, as GitHub-flavoured. Every generated workspace ships READMEs. */
export default [
  {
    files: ['**/*.md'],
    plugins: { markdown },
    language: 'markdown/gfm',
    rules: {
      'markdown/no-empty-links': 'error',
      'markdown/no-invalid-label-refs': 'error',
      'markdown/no-duplicate-headings': 'off',
    },
  },
]
