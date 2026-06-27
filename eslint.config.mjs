import jest from 'eslint-plugin-jest'
import neostandard from 'neostandard'

export default [
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'assets/', 'scripts/'] },
  ...neostandard({ ts: true }),
  {
    ...jest.configs['flat/recommended'],
    files: ['**/*.test.ts'],
  },
  {
    // Match the no-semicolon + trailing-comma style nx-magic itself generates.
    rules: {
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      // We intentionally emit ${...} literals (VSCode launch vars, npm authToken).
      'no-template-curly-in-string': 'off',
    },
  },
]
