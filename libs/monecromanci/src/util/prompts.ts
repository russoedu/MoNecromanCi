import { input, select } from '@inquirer/prompts'
import { diffLines } from 'diff'

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

/** A line from a `diffLines` chunk, without the trailing-newline artifact of a plain `.split('\n')`. */
function splitLines (value: string): string[] {
  const lines = value.split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }
  return lines
}

/**
 * Renders a human-readable `+`/`-` line diff between two strings.
 *
 * @remarks
 * Used to show the user exactly what a tool-owned file's on-disk content
 * would become before asking them to choose how to resolve the drift.
 *
 * @param before - The current on-disk content.
 * @param after - The canonical template content.
 * @returns The rendered diff, one line per line of input.
 * @throws Never - performs no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function renderDiff (before: string, after: string): string {
  return diffLines(before, after)
    .flatMap((change) => {
      const prefix = change.added ? '+' : (change.removed ? '-' : ' ')
      return splitLines(change.value).map((line) => `${prefix} ${line}`)
    })
    .join('\n')
}

/**
 * The four ways a user can resolve a tool-owned file's drift in `doctor --fix`.
 *
 * @remarks
 * `always`/`never` are meant to be persisted (in `MonecromanciConfig.fileSyncPreferences`)
 * so the file is never asked about again; `update`/`skip` apply once.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type DriftChoice = 'update' | 'skip' | 'always' | 'never'

/**
 * Prompts for how to resolve a single tool-owned file's drift.
 *
 * @remarks
 * Uses `@inquirer/prompts`'s `select` prompt so all four choices and their
 * full descriptions are visible up front (arrow keys + Enter), rather than
 * `expand`'s collapsed single-keypress hint that hides the option text
 * until the user knows to press "h". `always`/`never` are meant to be
 * persisted by the caller so the file is never asked about again.
 *
 * @param path - The drifted file's repo-relative path, shown in the message.
 * @returns The user's choice.
 * @throws Propagates any error `@inquirer/prompts`'s `select` raises (e.g.
 * when stdin is not a TTY).
 * @typeParam None - this function has no generic type parameters.
 */
export async function promptDriftChoice (path: string): Promise<DriftChoice> {
  return await select<DriftChoice>({
    message: `${path} differs from the canonical template — what do you want to do?`,
    default: 'update',
    choices: [
      { name: 'Update the file (just this once)', value: 'update' },
      { name: 'Skip the file (just this once)', value: 'skip' },
      { name: 'Always update this file from now on', value: 'always' },
      { name: 'Never update this file from now on', value: 'never' },
    ],
  })
}

export { checkbox, confirm, input, select } from '@inquirer/prompts'
