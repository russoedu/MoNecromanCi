import eslintReact from '@eslint-react/eslint-plugin'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

const eslintReactRecommended = eslintReact.configs['recommended-typescript']

/**
 * React correctness rules for JSX/TSX, including accessibility.
 *
 * @remarks
 * Formatting stays with Prettier.
 *
 * **The React rules come from `@eslint-react/eslint-plugin`, not
 * `eslint-plugin-react`.** The incumbent's latest release (7.37.5) peers on
 * `eslint: ^3 … ^9.7` and has no ESLint 10 build at all, so it — not ESLint —
 * is what pinned this whole config to ESLint 9. `@eslint-react` is a maintained
 * rewrite that peers on `eslint: "*"`. Every rule it has no equivalent for is a
 * class-component or `propTypes` rule; this project generates neither, and two
 * of them (`react-in-jsx-scope`, `prop-types`) were already switched off here.
 *
 * `recommended-typescript` rather than `recommended`: it is what the migration
 * guide prescribes, and in 5.18.1 the two resolve to an identical rule set, so
 * the choice costs nothing today and follows upstream if they diverge. Neither
 * needs type-aware parser services — only `recommended-type-checked` does — so
 * this block carries none of `configs/typeAware.js`'s scoping hazard, where a
 * file outside a tsconfig becomes a fatal parse error.
 *
 * **Hooks stay with the React team's own plugin.** `@eslint-react` reimplements
 * the hooks rules and ships a config to switch `eslint-plugin-react-hooks` off
 * in favour of them; this config does the opposite, because the canonical
 * `rules-of-hooks` and `exhaustive-deps` should come from the people who define
 * the rules of hooks. The two duplicated rule names are turned off on the
 * `@eslint-react` side so one defect is never reported twice with two different
 * messages. Its *other* hook-adjacent rules — `purity`, `set-state-in-effect`,
 * `use-memo` and friends — have no counterpart enabled here and stay on.
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
    name: 'mnci/react',
    files: ['**/*.{jsx,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: {
      ...eslintReactRecommended.plugins,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y
    },
    settings: { ...eslintReactRecommended.settings },
    rules: {
      ...eslintReactRecommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,

      // The two rules both plugins implement. See the remarks above: the React
      // team's plugin is the authority, so `@eslint-react`'s copies go off
      // rather than reporting the same defect twice.
      '@eslint-react/rules-of-hooks': 'off',
      '@eslint-react/exhaustive-deps': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // A component's return type is always JSX and TypeScript infers it
      // precisely. Annotating every one adds noise and no information — and it
      // would make Nx's own generated `app.tsx` fail lint in a workspace the
      // user has not touched yet. Still enforced on plain `.ts`, where the
      // return type is real API surface.
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  }
]
