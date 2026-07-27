import yml from 'eslint-plugin-yml'

/**
 * YAML correctness — matters here because every generated workspace ships CI
 * pipeline YAML, and a duplicate key or bad anchor silently changes a build.
 */
export default [
  ...yml.configs['flat/recommended'],
  {
    files: ['**/*.{yml,yaml}'],
    rules: {
      // Formatting belongs to Prettier, which handles YAML natively.
      'yml/no-empty-mapping-value': 'off',
    },
  },
]
