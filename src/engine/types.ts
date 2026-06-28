/**
 * The five kinds of project nx-magic can generate.
 *
 * @remarks
 * Drives which generator and template set {@link generateProject} uses.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type ProjectKind
  = | 'internal-lib'
    | 'publishable-lib'
    | 'cli-tool'
    | 'function-app'
    | 'react-app'

/**
 * Azure DevOps coordinates used for Artifacts publishing and docs upload.
 *
 * @remarks
 * Supplied once per monorepo and threaded through to every publishable project.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface AzureConfig {
  organization:  string
  project:       string
  artifactsFeed: string
}

/**
 * Contents of the per-repo `.nx-magic.json` stamp.
 *
 * @remarks
 * Read and written by {@link loadConfig} and {@link saveConfig}.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface NxMagicConfig {
  templateVersion: string
  workspaceName:   string
  displayName:     string
  scope:           string
  defaultBase:     string
  nodeVersion:     string
  azure:           AzureConfig
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
  workspaceName: string
  /** Human-friendly name used in the `.code-workspace` folder label. */
  displayName:   string
  scope:         string
  defaultBase:   string
  nodeVersion:   string
  azure:         AzureConfig
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
  /** Azure coordinates, used to set the publish registry for publishable kinds. */
  azure?:      AzureConfig
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
