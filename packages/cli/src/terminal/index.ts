/**
 * Terminal I/O: interactive prompts in, coloured status out.
 *
 * @remarks
 * The deliberate public API of this slice: a sibling reaches it only
 * through this barrel, never by a path into the files below.
 */

export * from './logger.client'
export * from './prompts.client'
