/**
 * The kinds of project MoNecromanCI can generate.
 *
 * @remarks
 * Drives which generator and template set {@link generateProject} uses. Backend
 * (`function-app`, `node-app`), frontend (`react-app`, `vue-app`, `svelte-app`),
 * full-stack (`nextjs-app`) and library (`internal-lib`, `publishable-lib`,
 * `cli-tool`) kinds.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type ProjectKind
  = | 'internal-lib'
    | 'publishable-lib'
    | 'cli-tool'
    | 'function-app'
    | 'node-app'
    | 'react-app'
    | 'vue-app'
    | 'svelte-app'
    | 'nextjs-app'

/**
 * Azure DevOps coordinates for an Azure Artifacts npm feed.
 *
 * @remarks
 * Embedded in {@link RegistryConfig} for the `azure-artifacts` registry kind.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface AzureConfig {
  organization:  string
  project:       string
  artifactsFeed: string
}

/**
 * The continuous-integration provider(s) a generated monorepo targets.
 *
 * @remarks
 * `both` emits an Azure Pipelines file and a GitHub Actions workflow; the
 * vendored `.build-templates` engine is shared by either.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type CiProvider = 'azure' | 'github' | 'both'

/**
 * Where a monorepo publishes its publishable libraries and CLI tools.
 *
 * @remarks
 * A discriminated union: Azure Artifacts (scoped feed), GitHub Packages (one
 * owner) or the public npm registry. {@link registryUrl} maps it to a URL.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type RegistryConfig
  = | ({ kind: 'azure-artifacts' } & AzureConfig)
    | { kind: 'github-packages', owner: string }
    | { kind: 'npm' }

/**
 * Contents of the per-repo `.monecromanci.json` stamp.
 *
 * @remarks
 * Read and written by {@link loadConfig} and {@link saveConfig}. The optional
 * `azure` field is a legacy v1 stamp shape; {@link loadConfig} migrates it into
 * {@link RegistryConfig} on read.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface MonecromanciConfig {
  templateVersion:      string
  workspaceName:        string
  displayName:          string
  scope:                string
  defaultBase:          string
  nodeVersion:          string
  ci:                   CiProvider
  registry:             RegistryConfig
  /**
   * Branches that trigger the CI pipeline. `undefined` on stamps written
   * before this setting existed — `doctor`/`resurrect`/`update` prompt for it
   * once, then persist it here.
   */
  triggerBranches?:     string[]
  /**
   * Per-file drift resolution remembered from `doctor`'s interactive prompt,
   * keyed by the file's repo-relative path (the same strings used in
   * {@link FileSpec.path}/`SyncReport.drift`). `'always'` silently re-applies
   * the canonical content on every future run; `'never'` silently leaves the
   * file alone. Absent (or no entry for a path) means "ask when drifted."
   */
  fileSyncPreferences?: Record<string, 'always' | 'never'>
  /** Legacy v1 field; migrated to {@link MonecromanciConfig.registry} on load. */
  azure?:               AzureConfig
}

/**
 * Inputs needed to render the monorepo-level templates.
 *
 * @remarks
 * Passed to {@link monorepoFiles}.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface MonorepoVars {
  /** kebab-case workspace slug, also the root package name. */
  workspaceName:   string
  /** Human-friendly name used in the `.code-workspace` folder label. */
  displayName:     string
  scope:           string
  defaultBase:     string
  nodeVersion:     string
  ci:              CiProvider
  registry:        RegistryConfig
  /** Branches that trigger the CI pipeline (both Azure Pipelines and GitHub Actions). */
  triggerBranches: string[]
}

/**
 * Inputs needed to render a single project's templates.
 *
 * @remarks
 * Passed to the per-kind `*Files` generators (e.g. {@link internalLibFiles}).
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface ProjectVars {
  kind:        ProjectKind
  /** kebab-case project slug (the NX project name and folder name). */
  name:        string
  /** Fully-qualified npm package name, e.g. `@scope/name`. */
  packageName: string
  scope:       string
  /** Publish registry, threaded through for publishable kinds. */
  registry?:   RegistryConfig
}

/**
 * A file produced by a template.
 *
 * @remarks
 * `tool-owned` files are regenerated verbatim on every sync (doctor overwrites
 * drift). `scaffold` files are only created when missing so user edits survive.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface FileSpec {
  path:      string
  content:   string
  ownership: 'tool-owned' | 'scaffold'
}
