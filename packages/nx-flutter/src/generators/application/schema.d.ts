/**
 * Options accepted by the `application` generator.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface AppGeneratorSchema {
  /** The project name. */
  name:       string
  /** Workspace-relative directory (defaults to `apps/<name>`). */
  directory?: string
}
