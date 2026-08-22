import base from './configs/base.js'
import css from './configs/css.js'
import dependencyChecks from './configs/dependencyChecks.js'
import html from './configs/html.js'
import importGraph from './configs/importGraph.js'
import jest from './configs/jest.js'
import json from './configs/json.js'
import markdown from './configs/markdown.js'
import react from './configs/react.js'
import regexp from './configs/regexp.js'
import standard from './configs/standard.js'
import toml from './configs/toml.js'
import typeAware from './configs/typeAware.js'
import typescript from './configs/typescript.js'
import yaml from './configs/yaml.js'

export { default as base } from './configs/base.js'
export { default as css } from './configs/css.js'
export { default as dependencyChecks } from './configs/dependencyChecks.js'
export { default as html } from './configs/html.js'
export { default as importGraph } from './configs/importGraph.js'
export { default as jest } from './configs/jest.js'
export { default as json } from './configs/json.js'
export { default as markdown } from './configs/markdown.js'
export { default as react } from './configs/react.js'
export { default as regexp } from './configs/regexp.js'
export { default as standard } from './configs/standard.js'
export { default as toml } from './configs/toml.js'
export { default as typeAware } from './configs/typeAware.js'
export { default as typescript } from './configs/typescript.js'
export { default as yaml } from './configs/yaml.js'

/** Paths never worth linting, in any generated workspace. */
export const ignores = [
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
  '**/vite.config.*.timestamp*',
  // Non-JS ecosystems mnci supports; each has its own linter (ruff,
  // golangci-lint, flutter analyze) wired as that project's `lint` target.
  '**/.venv',
  '**/__pycache__',
  '**/.dart_tool'
]

/**
 * The complete mnci ESLint config: one root config for the whole workspace.
 *
 * @remarks
 * Composition order matters. `standard` is applied LAST because it IS the
 * formatting opinion, and nothing may follow that disables it. Where
 * `eslint-config-prettier` used to sit — switching every stylistic rule off so
 * a formatter could own them — there is now nothing, because there is no
 * formatter. Re-introducing it would silently disable all sixty Standard rules
 * and leave the workspace with no style enforcement at all: a disabled rule
 * reports nothing, so `lint` would pass
 * mutually unsatisfiable. See `configs/stylistic.js`.
 *
 * @param options - Composition options. Pass `workspaceRoot` (normally
 * `import.meta.dirname` from the root config) to enable the
 * `@nx/dependency-checks` block, which scans for `private: true` manifests.
 * Omit it in a workspace with no publishable npm packages.
 * @returns The flat config array.
 */
export default function mnci (options = {}) {
  const { workspaceRoot } = options
  return [
    { name: 'mnci/ignores', ignores },
    ...base,
    ...typescript,
    ...typeAware,
    ...importGraph,
    ...react,
    ...regexp,
    ...json,
    ...yaml,
    ...toml,
    ...markdown,
    ...css,
    ...html,
    ...jest,
    ...(workspaceRoot ? dependencyChecks(workspaceRoot) : []),
    // Formatting is Prettier's job — this must stay last.
    // LAST, and nothing may follow that disables it: this block IS the
    // formatting opinion now. `eslint-config-prettier` used to sit here to
    // switch every stylistic rule off for a formatter to own; with no
    // formatter, composing it would silently disable all 62 Standard rules.
    ...standard
  ]
}

/**
 * The blocks covering **only** the languages oxlint cannot parse.
 *
 * @remarks
 * For a workspace that has chosen oxlint. oxlint reads JS/TS/JSX/Vue and
 * nothing else, so on its own it leaves YAML, TOML, Markdown, CSS, HTML and
 * JSON linted by **nothing** — and drops `@nx/dependency-checks`, which is what
 * stops a publishable package's manifest from declaring the wrong dependencies.
 * In a scaffold whose point is publishable packages, losing that silently is
 * the worse trade, so `mnci new --linter=oxlint` writes an ESLint config built
 * from this instead of no ESLint config at all.
 *
 * **Composed from the same block modules `mnci()` uses**, not a parallel copy.
 * That is the whole reason this lives in the package rather than being
 * hand-assembled in the CLI's template string: a rule added to `configs/yaml.js`
 * reaches both modes, and there is no second list to forget.
 *
 * Deliberately absent, and each for a reason worth stating:
 *
 * - `base`, `typescript`, `typeAware`, `importGraph`, `react`, `regexp`, `jest`
 *   — oxlint owns JS/TS here. Including them would double-report every finding.
 * - `standard` — the JS/TS formatting opinion, which is JS-only by definition.
 *
 * @param options - Composition options. Pass `workspaceRoot` to enable the
 * `@nx/dependency-checks` block, which scans for `private: true` manifests.
 * @returns The flat config array for the non-JavaScript half.
 */
export function nonJs (options = {}) {
  const { workspaceRoot } = options
  return [
    { name: 'mnci/ignores', ignores },
    ...json,
    ...yaml,
    ...toml,
    ...markdown,
    ...css,
    ...html,
    ...(workspaceRoot ? dependencyChecks(workspaceRoot) : [])
  ]
}
