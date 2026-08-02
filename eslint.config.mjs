import tsdoc from 'eslint-plugin-tsdoc'
import tsdocRequire from 'eslint-plugin-tsdoc-require-2'
import mnci from '@mnci/eslint-config'

/**
 * This repo lints itself with the exact config it ships to the workspaces it
 * generates — the same three-line import a `mnci new` workspace gets.
 *
 * That is the point, not a convenience. This whole change exists because the
 * repo's own root had been hand-upgraded to a rich ~340-line config while
 * `overlay.ts` was never updated, so every generated workspace got Nx's bare
 * default instead. Dogfooding hid it: the repo worked, everything it produced
 * did not. Sharing one package makes that drift impossible to reintroduce —
 * a rule this repo relies on has to be a rule generated workspaces get too.
 *
 * The one deliberate extra below is TSDoc enforcement: an mnci-authoring
 * standard, not an opinion worth imposing on a user's workspace, so it stays
 * a root-only block layered on top rather than moving into the package.
 */
const tests = ['**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', '**/e2e/**']

export default [
  ...mnci({ workspaceRoot: import.meta.dirname }),

  // Repo-specific ignores, beyond the build output the shared config lists.
  { ignores: ['.azurite/**', '.build-templates/**', 'doc/**', 'tools/**', '**/assets/**'] },

  // Require TSDoc on exported .ts declarations. Tests and ambient declarations
  // are exempt, as are .tsx components (props are typed, the return is JSX).
  {
    ...tsdocRequire.configs.tsdoc,
    files: ['**/*.{ts,mts,cts}'],
    ignores: [...tests, '**/*.d.ts']
  },
  // Validate TSDoc syntax wherever a comment already exists.
  {
    files: ['**/*.{ts,mts,cts,tsx}'],
    plugins: { tsdoc },
    rules: { 'tsdoc/syntax': 'error' }
  },
  // overlay.ts's `rootScripts()` takes no parameters and has no type
  // parameters, so the require-* rules have nothing to match against.
  {
    files: ['packages/cli/src/overlay.ts'],
    rules: {
      'tsdoc-require-2/require-param': 'off',
      'tsdoc-require-2/require-type-param': 'off'
    }
  }
]
