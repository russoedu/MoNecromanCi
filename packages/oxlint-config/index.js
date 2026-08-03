import bridged from './configs/bridged.js'
import divergences from './configs/divergences.js'
import leaks from './configs/leaks.js'
import native from './configs/native.js'
import react, { REACT_FILES } from './configs/react.js'
import tests, { ENABLED as TEST_RULES, TEST_FILES } from './configs/tests.js'
import typeAware from './configs/typeAware.js'

export { default as bridged } from './configs/bridged.js'
export { default as divergences } from './configs/divergences.js'
export { default as leaks } from './configs/leaks.js'
export { default as native } from './configs/native.js'
export { default as react, REACT_FILES } from './configs/react.js'
export { default as tests, ENABLED as TEST_RULES, TEST_FILES } from './configs/tests.js'
export { default as typeAware } from './configs/typeAware.js'

/** Paths never worth linting, in any generated workspace. */
export const ignorePatterns = [
  '**/dist',
  '**/dist-dev',
  '**/dist-uat',
  '**/dist-prod',
  '**/out-tsc',
  '**/coverage',
  '**/.nx',
  '**/node_modules',
  '**/build',
  '**/.next',
  // Build artifacts, and the omission that made the generated root `lint` target
  // fail on a fresh workspace. `@nx/esbuild` writes intermediates here — for a
  // node-app, `tmp/<scope>/<name>/main-with-require-overrides.js` — and the root
  // lint target has no project directory to hide behind, so it linted them: 39
  // errors on generated code the user never wrote. `.prettierignore` has always
  // listed `tmp`, which is exactly why nothing noticed the asymmetry.
  '**/tmp',
  // Non-JS ecosystems mnci supports; each has its own linter.
  '**/.venv',
  '**/__pycache__',
  '**/.dart_tool'
]

/**
 * oxlint's built-in plugins this config uses.
 *
 * @remarks
 * `unicorn` is deliberately **absent**, and that is the single most important
 * line in this file. oxlint enables its own partial `unicorn` port by default;
 * this config gets `unicorn` from the real `eslint-plugin-unicorn` through the
 * JS bridge instead, so leaving the built-in on would report the same defect
 * twice under two different rule names — and would apply a rule set that is 169
 * rules short of the one `@mnci/eslint-config` uses.
 */
export const plugins = [
  'typescript',
  'oxc',
  'import',
  'promise',
  'node',
  'react',
  'jsx-a11y',
  'jest',
  'vitest'
]

/**
 * The ESLint plugins run through oxlint's JS bridge, closing the rules oxlint
 * has no Rust implementation for. See `configs/bridged.js`.
 */
export const jsPlugins = [
  // Aliased because oxlint has a built-in of the same name; the built-in is off.
  { name: 'unicorn-js', specifier: 'eslint-plugin-unicorn' },
  { name: 'regexp', specifier: 'eslint-plugin-regexp' }
]

/**
 * The complete mnci oxlint config: one root config for the whole workspace.
 *
 * @remarks
 * Consumed from an `oxlint.config.ts`, which is the **only** shareable-config
 * route oxlint offers:
 *
 * ```ts
 * import { defineConfig } from 'oxlint'
 * import mnci from '@mnci/oxlint-config'
 *
 * export default defineConfig({ extends: [mnci()] })
 * ```
 *
 * `.oxlintrc.json` cannot do this. Its `extends` takes **paths**, resolved
 * relative to the config file, so `extends: ["@mnci/oxlint-config"]` fails with
 * `No such file or directory` — oxlint looks for `./@mnci/oxlint-config`.
 * Verified both ways; an explicit `./node_modules/@mnci/oxlint-config/...` path
 * does work, but it hardcodes a hoisting layout npm does not guarantee.
 *
 * Composition order mirrors the ESLint config: the broad sets first, then the
 * narrower overrides, then `divergences` last so it wins over everything.
 *
 * @param options - Composition options. Pass `typeAware: true` to add the rules
 * that need `oxlint --type-aware`. **Off by default, and that is a correctness
 * decision rather than caution.** Measured on this ESLint-clean monorepo: the
 * default configuration reports 0 findings, while `--type-aware` reports 8 —
 * five `no-unnecessary-type-assertion` on casts ESLint accepts (its type-aware
 * block resolves a different tsconfig for spec files, since `tsconfig.lib.json`
 * excludes them), two bridged `unicorn` rules on the e2e script, and one
 * `tsconfig-error`. Every one of those is stricter than the ESLint stack, which
 * is the one thing this package promises not to be. So the promise holds for
 * what you get by default, and the stricter mode is a conscious opt-in with a
 * known cost rather than a surprise.
 * @returns The oxlint config object.
 */
export default function mnci(options = {}) {
  const { typeAware: withTypeAware = false } = options

  // The `typescript/*` rules go in a TS-scoped override rather than the base
  // rule set, mirroring `@mnci/eslint-config`, whose TypeScript block is
  // `files: ['**/*.{ts,mts,cts,tsx}']`. Applying them everywhere is not a
  // cosmetic difference: `typescript/no-require-imports` then fires on a
  // `.cjs` file, which the ESLint config lints clean because the rule never
  // reaches it. An Nx monorepo legitimately contains CJS, so that alone would
  // have broken the accept-everything-ESLint-accepts promise.
  const [typescriptRules, universalRules] = Object.entries(native).reduce(
    (split, [rule, config]) => {
      split[rule.startsWith('typescript/') ? 0 : 1][rule] = config
      return split
    },
    [{}, {}]
  )

  return {
    plugins,
    jsPlugins,
    ignorePatterns,
    // NO categories, and this is the load-bearing decision in the file.
    //
    // The tempting version is `categories: { correctness: 'error' }`, and a first
    // pass shipped exactly that on the strength of a real measurement: oxlint's
    // default `correctness` set reports zero on this monorepo. That measurement
    // was true and the conclusion drawn from it was still wrong — it was taken
    // with oxlint's DEFAULT plugins (unicorn, typescript, oxc), while this config
    // also enables `import`, `jest`, `vitest`, `promise`, `node`, `react` and
    // `jsx-a11y`. A category applies to every enabled plugin, so switching those
    // on silently enabled their whole correctness sets too.
    //
    // Measured on the real ESLint-clean monorepo, that produced **8 findings**
    // across 6 rules the ESLint config never enables — `jest/no-conditional-
    // expect`, `import/default` (resolver-dependent, the same class as the
    // `no-unresolved` the ESLint config switches off on purpose) and friends.
    // Every one of them was a file ESLint lints clean.
    //
    // So the rule set is exactly and only what `@mnci/eslint-config` enables,
    // enumerated. Parity becomes a property of the config rather than something
    // a category happens to approximate. Do not add a category here to "catch a
    // bit more" — that is how this package starts failing green codebases.
    categories: {},
    rules: {
      // `leaks` first, so anything below can switch a rule back on. It is the
      // floor ("oxlint's own opinions are not ours"), not an override.
      ...leaks,
      ...universalRules,
      ...bridged,
      // Last: a measured disagreement between the two linters outranks every
      // rule above it, because a rule that fires on ESLint-clean code is the
      // one failure this package must not ship.
      ...divergences
    },
    overrides: [
      {
        files: ['**/*.{ts,mts,cts,tsx}'],
        rules: { ...typescriptRules, ...(withTypeAware && typeAware) }
      },
      { files: REACT_FILES, rules: react },
      { files: TEST_FILES, rules: { ...TEST_RULES, ...tests } }
    ]
  }
}
