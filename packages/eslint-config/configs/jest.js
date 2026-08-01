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
    // `jest.*.{js,mjs,cjs,ts}` covers the setup/teardown files a workspace
    // wires through `setupFilesAfterEach` — they use the same globals as a
    // spec but match none of the spec patterns, so without this they fail
    // `no-undef` on `jest` and `afterEach`.
    files: [
      '**/*.{spec,test}.{js,mjs,cjs,jsx,ts,mts,cts,tsx}',
      '**/jest.*.{js,mjs,cjs,ts,mts,cts}',
      '**/vitest.*.{js,mjs,cjs,ts,mts,cts}',
      '**/test-setup.{js,mjs,cjs,ts,mts,cts}',
    ],
    plugins: { jest },
    // Vitest's own globals go alongside Jest's. `describe`/`it`/`expect` are
    // shared, but `vi` is Vitest-only and belongs to no Jest environment — so a
    // `.js` spec using `vi.fn()` reported `'vi' is not defined`, confirmed against
    // the real binary. Narrow (a `.ts` spec escapes it, since `no-undef` is off for
    // TypeScript) but a real failure on a file the user wrote normally.
    languageOptions: {
      globals: { ...jest.environments.globals.globals, vi: 'readonly', vitest: 'readonly' },
    },
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
