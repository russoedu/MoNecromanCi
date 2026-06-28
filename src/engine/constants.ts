/** Version stamp written into `.nx-magic.json`; bump when templates change. */
export const TEMPLATE_VERSION = '0.1.0'

/** Name of the per-repo manifest that records how a repo was generated. */
export const STAMP_FILE = '.nx-magic.json'

/** Default Node major version targeted by generated monorepos. */
export const DEFAULT_NODE_VERSION = '24'

/** Default git base branch used by Nx affected detection. */
export const DEFAULT_BASE = 'main'

/** Canonical NX project tags used to classify projects in CI. */
export const TAGS = {
  functionApp:    'type:function-app',
  reactApp:       'type:react-app',
  publishableLib: 'type:publishable-lib',
  internalLib:    'type:internal-lib',
  ignore:         'ci:ignore',
} as const
