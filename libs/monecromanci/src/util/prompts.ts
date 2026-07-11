import { input } from '@inquirer/prompts'

/**
 * Prompts for a non-empty trimmed string with an optional default.
 *
 * @remarks
 * Wraps `@inquirer/prompts`'s `input`, enforcing a non-empty result.
 *
 * @param message - The prompt message to display.
 * @param fallback - Optional default value pre-filled in the prompt.
 * @returns The trimmed, non-empty string the user entered.
 * @throws Propagates any error `@inquirer/prompts`'s `input` raises (e.g. when
 * stdin is not a TTY).
 * @typeParam None - this function has no generic type parameters.
 */
export async function promptText (message: string, fallback?: string): Promise<string> {
  const value = await input({
    message,
    default:  fallback,
    validate: (value: string) => value.trim().length > 0 || 'A value is required',
  })
  return value.trim()
}

/**
 * Splits a comma-separated branch list into trimmed, deduplicated names.
 *
 * @remarks
 * `Set` preserves first-seen order, so the result stays deterministic.
 *
 * @param raw - The raw comma-separated input.
 * @returns The parsed branch names, in first-seen order.
 * @throws Never - performs no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function splitBranchList (raw: string): string[] {
  return [...new Set(raw.split(',').map((branch) => branch.trim()).filter(Boolean))]
}

/**
 * Prompts for a comma-separated list of branch names.
 *
 * @remarks
 * Pre-fills the prompt with `fallback.join(', ')`; validates that at least
 * one branch remains after splitting.
 *
 * @param message - The prompt message to display.
 * @param fallback - The default branch list, shown pre-filled.
 * @returns The parsed, deduplicated branch names the user entered.
 * @throws Propagates any error `@inquirer/prompts`'s `input` raises (e.g. when
 * stdin is not a TTY).
 * @typeParam None - this function has no generic type parameters.
 */
export async function promptBranchList (message: string, fallback: string[]): Promise<string[]> {
  const raw = await input({
    message,
    default:  fallback.join(', '),
    validate: (value: string) => splitBranchList(value).length > 0 || 'At least one branch is required',
  })
  return splitBranchList(raw)
}

export { checkbox, select, confirm, input } from '@inquirer/prompts'
