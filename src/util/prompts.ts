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

export { checkbox, select, confirm, input } from '@inquirer/prompts'
