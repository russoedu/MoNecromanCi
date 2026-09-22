/**
 * Validates a project name before it reaches a generator or a path.
 *
 * @remarks
 * The deliberate public API of this slice: a sibling reaches it only
 * through this barrel, never by a path into the files below.
 */

export * from './project-name.validator'
