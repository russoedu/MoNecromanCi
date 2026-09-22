/**
 * Checks whether a newer @mnci/cli has been published.
 *
 * @remarks
 * The deliberate public API of this slice: a sibling reaches it only
 * through this barrel, never by a path into the files below.
 */

export * from './check-for-update.use-case'
