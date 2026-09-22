/**
 * Filesystem access in the shapes mnci needs: JSON, JSONC workspace files, ensured writes, executable bits.
 *
 * @remarks
 * The deliberate public API of this slice: a sibling reaches it only
 * through this barrel, never by a path into the files below.
 */

export * from './file-system.client'
