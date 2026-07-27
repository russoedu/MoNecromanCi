import jest from 'eslint-plugin-jest'

/**
 * Test-file overrides.
 *
 * Applies to both Jest and Vitest specs: the two stacks mnci offers share the
 * same `describe`/`it`/`expect` globals, so the relaxations below are correct
 * for either.
 */
export default [
  {
    files: ['**/*.{spec,test}.{js,mjs,cjs,jsx,ts,mts,cts,tsx}', '**/jest.setup.*'],
    plugins: { jest },
    languageOptions: { globals: { ...jest.environments.globals.globals } },
    rules: {
      'jest/no-focused-tests': 'error',
      'jest/no-identical-title': 'error',
      'jest/valid-expect': 'error',

      // Tests legitimately reach for `any` and non-null assertions on fixtures.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      'unicorn/no-useless-undefined': 'off',
    },
  },
]
