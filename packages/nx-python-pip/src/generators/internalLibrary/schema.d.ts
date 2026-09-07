/**
 * Options accepted by the `internal-library` generator.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface InternalLibraryGeneratorSchema {
  /** The project name. */
  name:       string
  /** Workspace-relative directory (defaults to `libs/<name>`). */
  directory?: string
}
