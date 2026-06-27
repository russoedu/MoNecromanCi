import { checkbox, confirm, input, select } from '@inquirer/prompts'

export { checkbox, confirm, input, select }

/** Prompts for a non-empty trimmed string with an optional default. */
export async function promptText (message: string, fallback?: string): Promise<string> {
  return (
    await input({
      message,
      default: fallback,
      validate: (value: string) => value.trim().length > 0 || 'A value is required',
    })
  ).trim()
}
