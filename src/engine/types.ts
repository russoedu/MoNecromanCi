/** The five kinds of project nx-magic can generate. */
export type ProjectKind =
  | 'internal-lib'
  | 'publishable-lib'
  | 'cli-tool'
  | 'function-app'
  | 'react-app'

/** Azure DevOps coordinates used for Artifacts publishing and docs upload. */
export interface AzureConfig {
  organization: string
  project: string
  artifactsFeed: string
}

/** Contents of the per-repo `.nx-magic.json` stamp. */
export interface NxMagicConfig {
  templateVersion: string
  workspaceName: string
  displayName: string
  scope: string
  defaultBase: string
  nodeVersion: string
  azure: AzureConfig
}

/** Inputs needed to render the monorepo-level templates. */
export interface MonorepoVars {
  /** kebab-case workspace slug, also the root package name. */
  workspaceName: string
  /** Human-friendly name used in the `.code-workspace` folder label. */
  displayName: string
  scope: string
  defaultBase: string
  nodeVersion: string
  azure: AzureConfig
}

/** Inputs needed to render a single project's templates. */
export interface ProjectVars {
  kind: ProjectKind
  /** kebab-case project slug (the NX project name and folder name). */
  name: string
  /** Fully-qualified npm package name, e.g. `@scope/name`. */
  packageName: string
  scope: string
  /** Azure coordinates, used to set the publish registry for publishable kinds. */
  azure?: AzureConfig
}

/**
 * A file produced by a template.
 *
 * `tool-owned` files are regenerated verbatim on every sync (doctor overwrites
 * drift). `scaffold` files are only created when missing so user edits survive.
 */
export interface FileSpec {
  path: string
  content: string
  ownership: 'tool-owned' | 'scaffold'
}
