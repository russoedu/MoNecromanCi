/**
 * Runs the Nx and npm CLIs, always through an argv array so no argument is ever shell-interpreted.
 *
 * @remarks
 * The deliberate public API of this slice: a sibling reaches it only
 * through this barrel, never by a path into the files below.
 */

export * from './nx.client'
