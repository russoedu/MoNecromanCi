import type { OrchestrationContext } from 'durable-functions'

/**
 * Declares the custom statuses an orchestration can report.
 *
 * @remarks
 * `const` on the type parameter preserves the literal types, so `setStatus`
 * can check the key against the actual set rather than against `string`. The
 * object is returned unchanged — this is a typing device, not a transform.
 *
 * @param statuses - The status map.
 * @returns The same object, with its literal types preserved.
 * @throws Never - returns its argument.
 * @typeParam T - The status map's literal type.
 */
export function defineStatuses<const T extends Record<string, string>> (statuses: T): T {
  return statuses
}

/**
 * Sets the orchestration's custom status from a declared set.
 *
 * @remarks
 * `setCustomStatus` accepts `unknown`, so a typo in a status string is invisible
 * until someone reads the instance's status and finds a value nothing produces.
 * Constraining `key` to the declared map is the whole point.
 *
 * @param context - The orchestration context.
 * @param statuses - The declared status map.
 * @param key - Which status to set; checked against the map.
 * @returns Nothing.
 * @throws Never - delegates to the SDK.
 * @typeParam T - The status map's literal type.
 */
export function setStatus<T extends Record<string, string>> (
  context: OrchestrationContext,
  statuses: T,
  key: keyof T
): void {
  context.df.setCustomStatus(statuses[key])
}
