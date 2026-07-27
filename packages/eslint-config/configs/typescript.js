import tseslint from 'typescript-eslint'

/**
 * TypeScript correctness rules.
 *
 * Uses the non-type-checked recommended set: type-aware linting needs a
 * `project` pointing at every tsconfig in the workspace, which a generated
 * monorepo cannot know up front (projects are added later by `mnci add`).
 * Consumers that want type-aware rules can layer them on per project.
 */
export default [
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['**/*.{ts,mts,cts,tsx}'],
  })),
  {
    files: ['**/*.{ts,mts,cts,tsx}'],
    rules: {
      // The base rules misfire on TS overloads and declaration merging.
      'no-redeclare': 'off',
      'no-undef': 'off',

      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
    },
  },
  {
    // Declaration files legitimately re-declare and use `any` in vendor types.
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
]
