/**
 * Options accepted by the `build` executor.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface BuildExecutorSchema {
  /**
   * Workspace-relative output directory for the web bundle
   * (e.g. `dist/apps/web`). Resolved against the workspace root, not the
   * project directory.
   */
  outputPath: string
}
