import prettierConfig from 'eslint-config-prettier'
import { named } from './configs/named.js'
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
import stylistic from './configs/stylistic.js'
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
export { default as stylistic } from './configs/stylistic.js'
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
 * Composition order matters. `eslint-config-prettier` is applied LAST so it
 * can switch off any formatting rule a plugin's recommended set turned on —
 * Prettier owns formatting. The stylistic block is composed after it, and
 * holds only rules `eslint-config-prettier` does not disable, i.e. ones
 * Prettier never touches at all. It deliberately does NOT re-enable anything
 * that config switched off: those are switched off because they contradict
 * Prettier's output, so re-enabling one would make `lint` and `format:check`
 * mutually unsatisfiable. See `configs/stylistic.js`.
 *
 * @param options - Composition options. Pass `workspaceRoot` (normally
 * `import.meta.dirname` from the root config) to enable the
 * `@nx/dependency-checks` block, which scans for `private: true` manifests.
 * Omit it in a workspace with no publishable npm packages.
 * @returns The flat config array.
 */
export default function mnci(options = {}) {
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
    ...named('mnci/prettier-compat', [prettierConfig]),
    ...stylistic
  ]
}
