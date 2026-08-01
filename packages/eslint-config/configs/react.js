import jsxA11y from 'eslint-plugin-jsx-a11y'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

/**
 * React correctness rules for JSX/TSX, including accessibility.
 *
 * @remarks
 * Formatting stays with Prettier.
 *
 * `jsx-a11y` is here rather than in `configs/html.js` because the two cover
 * genuinely different files: `@html-eslint`'s rules — `require-img-alt` and
 * friends — apply to `**\/*.html` only, so an `<img>` inside a component was
 * checked by nothing at all. With two React project kinds (`react-app`,
 * `react-lib`) that was the largest hole in this config's coverage, and it also
 * made the docs' "HTML + a11y" claim true of `.html` and not of JSX.
 *
 * Accessibility is a correctness concern, not a style one — an image with no
 * alternative text is unusable to a screen reader, which is a defect in the same
 * sense a dropped `await` is — so it belongs in this config's scope rather than
 * being left to a reviewer to notice.
 */
export default [
  {
    files: ['**/*.{jsx,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      ...jsxA11y.flatConfigs.recommended.rules,

      // The modern JSX transform makes these obsolete.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',

      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // A component's return type is always JSX and TypeScript infers it
      // precisely. Annotating every one adds noise and no information — and it
      // would make Nx's own generated `app.tsx` fail lint in a workspace the
      // user has not touched yet. Still enforced on plain `.ts`, where the
      // return type is real API surface.
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
]
