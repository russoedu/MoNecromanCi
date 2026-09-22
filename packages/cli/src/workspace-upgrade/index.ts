/**
 * Re-applies the overlay to an existing workspace (`mnci upgrade`).
 *
 * @remarks
 * The deliberate public API of this slice: a sibling reaches it only
 * through this barrel, never by a path into the files below.
 */

export * from './upgrade-workspace.use-case'
