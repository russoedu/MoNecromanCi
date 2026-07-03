/**
 * Converts an arbitrary workspace or project name into a safe lower-case slug
 * (single dashes, no leading/trailing separators). Splits camelCase/PascalCase
 * boundaries so `QuotesManager` becomes `quotes-manager`.
 *
 * @remarks
 * Interior dots are preserved so dotted package names like `jato.index` keep
 * their requested spelling (valid for npm names, NX projects and folders on
 * every OS). Leading/trailing dots are stripped — npm forbids a leading dot
 * and Windows cannot end a folder name with one.
 *
 * @param input - The raw name to slugify.
 * @returns The lower-case slug.
 * @throws Never - performs no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function toSlug (input: string): string {
  return input
    .trim()
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll(/[^a-zA-Z0-9]+/g, (separators) => (separators.includes('.') ? '.' : '-'))
    .replaceAll(/^[-.]+|[-.]+$/g, '')
    .toLowerCase()
}

/**
 * Sanitises a name into an UPPER_SNAKE token usable as an Azure pipeline
 * variable suffix (mirrors `sanitizeVariableToken` in the build templates).
 *
 * @remarks
 * Pure string transform; performs no I/O.
 *
 * @param input - The raw name to sanitise.
 * @returns The UPPER_SNAKE token.
 * @throws Never - performs no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function toVariableToken (input: string): string {
  return input
    .trim()
    .replaceAll(/[^A-Za-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .toUpperCase()
}
