/**
 * Version stamp written into `.nx-magic.json`; bump when templates change.
 *
 * @remarks
 * `doctor`/`update` compare this against the stamp on disk to know whether a
 * repo's tool-owned files need re-syncing.
 */
export const TEMPLATE_VERSION = '0.1.0'

/**
 * Name of the per-repo manifest that records how a repo was generated.
 *
 * @remarks
 * Lives at the repo root, alongside `package.json`.
 */
export const STAMP_FILE = '.nx-magic.json'

/**
 * Default Node major version targeted by generated monorepos.
 *
 * @remarks
 * Used as the fallback when `nx-magic new` runs non-interactively.
 */
export const DEFAULT_NODE_VERSION = '24'

/**
 * Default git base branch used by Nx affected detection.
 *
 * @remarks
 * Used as the fallback when `nx-magic new` runs non-interactively.
 */
export const DEFAULT_BASE = 'main'

/**
 * Canonical NX project tags used to classify projects in CI.
 *
 * @remarks
 * Read back by {@link discoverProjects} to infer a project's {@link ProjectKind}
 * from its `project.json` tags.
 */
export const TAGS = {
  functionApp:    'type:function-app',
  reactApp:       'type:react-app',
  publishableLib: 'type:publishable-lib',
  internalLib:    'type:internal-lib',
  ignore:         'ci:ignore',
} as const
