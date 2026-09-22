/**
 * Read-only invariant checks over an existing workspace (`mnci doctor`).
 *
 * @remarks
 * The deliberate public API of this slice: a sibling reaches it only
 * through this barrel, never by a path into the files below.
 */

export * from './check-invariants.use-case'
