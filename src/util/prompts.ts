import { input } from '@inquirer/prompts'

/** Prompts for a non-empty trimmed string with an optional default. */
export async function promptText (message: string, fallback?: string): Promise<string> {
  const value = await input({
    message,
    default:  fallback,
    validate: (value: string) => value.trim().length > 0 || 'A value is required',
  })
  return value.trim()
}

export { checkbox, select, confirm, input } from '@inquirer/prompts'
