import { input, select } from '@inquirer/prompts'
import type { RegistryConfig, StackConfig } from './overlay'

/**
 * Prompts for a non-empty trimmed string with an optional default.
 *
 * @remarks
 * Wraps `@inquirer/prompts`'s `input`, enforcing a non-empty result. Ported
 * from v1 `util/prompts.ts`.
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
 * Prompts for the publish registry (Azure Artifacts coordinates, or npm).
 *
 * @remarks
 * Azure Artifacts needs three coordinates (organization/project/feed) to build
 * the registry URL; public npm needs nothing further.
 *
 * @param fallbackOrganization - Default Azure DevOps organization, if any.
 * @returns The resolved registry configuration.
 * @throws Propagates any error `@inquirer/prompts` raises (e.g. when stdin is
 * not a TTY).
 * @typeParam None - this function has no generic type parameters.
 */
export async function promptRegistry (fallbackOrganization?: string): Promise<RegistryConfig> {
  const kind = await select<RegistryConfig['kind']>({
    message: 'Package registry for publishable libraries',
    choices: [
      { name: 'Azure Artifacts', value: 'azure-artifacts' },
      { name: 'Public npm', value: 'npm' },
    ],
  })

  if (kind === 'npm') {
    return { kind }
  }

  return {
    kind,
    organization:  await promptText('Azure DevOps organization', fallbackOrganization),
    project:       await promptText('Azure DevOps project'),
    artifactsFeed: await promptText('Artifacts feed name'),
  }
}

/**
 * Prompts for the stack: linter and unit-test runner.
 *
 * @remarks
 * The knobs asked up front at `mnci2 new`. TypeScript is fixed (the
 * `--preset=ts` premise, pinned to the TS 6 that Nx 23 supports), so only the
 * linter and test runner are asked. Each is a binary choice — no "none" — with
 * the current opinionated default listed first.
 *
 * @param None - this function takes no parameters.
 * @returns The resolved stack configuration.
 * @throws Propagates any error `@inquirer/prompts` raises (e.g. non-TTY stdin).
 * @typeParam None - this function has no generic type parameters.
 */
export async function promptStack (): Promise<StackConfig> {
  const linter = await select<StackConfig['linter']>({
    message: 'Linter',
    choices: [
      { name: 'ESLint', value: 'eslint' },
      { name: 'Oxlint', value: 'oxlint' },
    ],
  })
  const testRunner = await select<StackConfig['testRunner']>({
    message: 'Unit-test runner',
    choices: [
      { name: 'Jest', value: 'jest' },
      { name: 'Vitest', value: 'vitest' },
    ],
  })
  return { linter, testRunner }
}
