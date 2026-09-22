/**
 * Converging declared dependency ranges (`mnci sync`) and updating them (`mnci up`) across every ecosystem.
 *
 * @remarks
 * The deliberate public API of this slice: a sibling reaches it only
 * through this barrel, never by a path into the files below.
 */

export * from './sync-dependencies.use-case'
export * from './update-dependencies.use-case'
