import yml from 'eslint-plugin-yml'
import { named } from './named.js'

/**
 * YAML correctness — matters here because every generated workspace ships CI
 * pipeline YAML, and a duplicate key or bad anchor silently changes a build.
 */
export default [
  ...named('mnci/yaml/recommended', yml.configs['flat/recommended']),
  {
    name: 'mnci/yaml',
    files: ['**/*.{yml,yaml}'],
    rules: {
      // Formatting belongs to Prettier, which handles YAML natively.
      'yml/no-empty-mapping-value': 'off'
    }
  }
]
