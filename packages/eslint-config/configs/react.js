import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

/** React correctness rules for JSX/TSX. Formatting stays with Prettier. */
export default [
  {
    files: ['**/*.{jsx,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,

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
