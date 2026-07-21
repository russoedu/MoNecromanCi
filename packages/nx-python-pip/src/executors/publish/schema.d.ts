/**
 * Options accepted by the `publish` executor.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface PublishExecutorSchema {
  /** Preview instead of uploading. Set automatically by `nx release publish --dry-run`. */
  dryRun?: boolean
}
