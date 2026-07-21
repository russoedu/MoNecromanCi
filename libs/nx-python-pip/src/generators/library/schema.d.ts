/**
 * Options accepted by the `library` generator.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface LibraryGeneratorSchema {
  /** The project name. */
  name:       string
  /** Workspace-relative directory (defaults to `libs/<name>`). */
  directory?: string
}
