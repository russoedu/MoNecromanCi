/**
 * Adds one project of a given kind, and applies the post-generation repairs every kind needs.
 *
 * @remarks
 * The deliberate public API of this slice: a sibling reaches it only
 * through this barrel, never by a path into the files below.
 */

export * from './add-project.use-case'
export * from './post-generation.use-case'
