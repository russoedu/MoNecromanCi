/**
 * Converts an arbitrary workspace or project name into a safe kebab-case slug
 * (lower-case, single dashes, no leading/trailing separators). Splits
 * camelCase/PascalCase boundaries so `QuotesManager` becomes `quotes-manager`.
 */
export function toSlug (input: string): string {
  return input
    .trim()
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll(/[^a-zA-Z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .toLowerCase()
}

/**
 * Sanitises a name into an UPPER_SNAKE token usable as an Azure pipeline
 * variable suffix (mirrors `sanitizeVariableToken` in the build templates).
 */
export function toVariableToken (input: string): string {
  return input
    .trim()
    .replaceAll(/[^A-Za-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .toUpperCase()
}
