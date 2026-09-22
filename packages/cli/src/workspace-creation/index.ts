/**
 * Creates a new workspace, from flags or from the interactive wizard.
 *
 * @remarks
 * The deliberate public API of this slice: a sibling reaches it only
 * through this barrel, never by a path into the files below.
 */

export * from './create-workspace.use-case'
export * from './interactive-wizard.use-case'
