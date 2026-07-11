/**
 * Version stamp written into `.monecromanci.json`; bump when templates change.
 *
 * @remarks
 * `doctor`/`update` compare this against the stamp on disk to know whether a
 * repo's tool-owned files need re-syncing.
 */
export const TEMPLATE_VERSION = '0.3.0'

/**
 * Name of the per-repo manifest that records how a repo was generated.
 *
 * @remarks
 * Lives at the repo root, alongside `package.json`.
 */
export const STAMP_FILE = '.monecromanci.json'

/**
 * Default Node major version targeted by generated monorepos.
 *
 * @remarks
 * Used as the fallback when `monecromanci new` runs non-interactively.
 */
export const DEFAULT_NODE_VERSION = '24'

/**
 * Default git base branch used by Nx affected detection.
 *
 * @remarks
 * Used as the fallback when `monecromanci new` runs non-interactively.
 */
export const DEFAULT_BASE = 'main'

/**
 * Default branches that trigger the CI pipeline (both Azure Pipelines and
 * GitHub Actions).
 *
 * @remarks
 * Matches the list every generated repo used before this became configurable,
 * so accepting the default causes zero drift for anyone upgrading.
 */
export const DEFAULT_TRIGGER_BRANCHES = ['dev', 'development', 'uat', 'master', 'main']

/**
 * Repo-root paths a prior template version generated but the current one no
 * longer does, now that `monecromanci-toolchain` is a devDependency and this
 * content is referenced from `node_modules/monecromanci-toolchain` instead
 * of vendored.
 *
 * @remarks
 * `doctor` uses this to clean up already-generated repos. Deliberately a
 * hardcoded, append-only list rather than a generic diff-driven prune —
 * doctor should never delete a path it didn't itself create in some prior
 * template version. Never remove an entry once a released version has
 * shipped it; only ever append.
 */
export const OBSOLETE_TOOL_OWNED_PATHS = [
  'tsconfig.base.json',
  'tsconfig.jest.json',
  'jest.preset.mjs',
  'jest.setup.mjs',
  'jest.clear.mjs',
  'typedoc.json',
  // The shared CI engine and the per-project helper scripts: all now called
  // straight out of node_modules/monecromanci-toolchain instead of being vendored.
  '.build-templates',
  'tools/generate-dist-package.mjs',
  'tools/clean-config.mjs',
  'tools/next-build.mjs',
]

/**
 * Canonical NX project tags used to classify projects in CI.
 *
 * @remarks
 * Read back by {@link discoverProjects} to infer a project's {@link ProjectKind}
 * from its `project.json` tags.
 */
export const TAGS = {
  functionApp:    'type:function-app',
  nodeApp:        'type:node-app',
  reactApp:       'type:react-app',
  vueApp:         'type:vue-app',
  svelteApp:      'type:svelte-app',
  nextjsApp:      'type:nextjs-app',
  publishableLib: 'type:publishable-lib',
  internalLib:    'type:internal-lib',
  ignore:         'ci:ignore',
} as const
