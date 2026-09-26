/**
 * Options accepted by the `publish` executor.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface PublishExecutorSchema {
  /** Preview instead of uploading. Set automatically by `nx release publish --dry-run`. */
  dryRun?:               boolean
  /**
   * What the version step resolved for every project in this release, keyed by
   * project name. Set automatically by `nx release publish`, which namespaces
   * it precisely so userland executors like this one can read it; it is
   * deliberately absent from `schema.json`, exactly as `@nx/js:release-publish`
   * leaves it, because nothing on a command line ever passes it.
   */
  nxReleaseVersionData?: Record<string, {
    currentVersion: string
    /** `null` when the release resolved no new version for that project. */
    newVersion:     string | null
    [key: string]:  unknown
  }>
}
