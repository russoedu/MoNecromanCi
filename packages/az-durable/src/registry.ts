/**
 * Duplicate-name detection for activities and orchestrations.
 *
 * @remarks
 * Activity and orchestration names are **global to the Function App** and are
 * baked into orchestration history in the task hub. Two features registering
 * the same string is a silent misbinding: the second registration wins, and the
 * first feature's calls quietly execute the wrong handler. Nothing surfaces
 * until replay, by which point the history already refers to the wrong thing.
 *
 * Failing loudly at startup is strictly better, so registration throws.
 */

/** Every name registered so far, and where. Module-level, matching the SDK's own global scope. */
const registered = new Map<string, string>()

/**
 * Records a name, throwing if it was already taken.
 *
 * @remarks
 * The error names **both** call sites when the stack makes them available. A
 * bare "duplicate name" message sends the reader hunting through a Function App
 * for the other registration, which is the slowest part of fixing this.
 *
 * @param kind - `activity` or `orchestration`, for the message.
 * @param name - The name being registered.
 * @returns Nothing.
 * @throws Error when `name` has already been registered.
 * @typeParam None - this function has no generic type parameters.
 */
export function claimName (kind: 'activity' | 'orchestration', name: string): void {
  const previous = registered.get(name)
  if (previous !== undefined) {
    throw new Error(
      `Duplicate ${kind} name '${name}'. Names are global to the Function App and are ` +
        'baked into orchestration history, so two registrations silently misbind.\n' +
        `  first registered at: ${previous}\n` +
        `  registered again at: ${callSite()}`
    )
  }
  registered.set(name, callSite())
}

/**
 * Clears the registry. Test-only.
 *
 * @remarks
 * Module state persists across tests in the same worker, so without this a
 * second test registering the same name fails for the wrong reason. Not
 * exported from the package entry point — it is only reachable inside the
 * package's own tests.
 *
 * @param None - this function takes no parameters.
 * @returns Nothing.
 * @throws Never - clears a map.
 * @typeParam None - this function has no generic type parameters.
 */
export function resetRegistryForTests (): void {
  registered.clear()
}

/**
 * The caller's source location, as best the stack can tell.
 *
 * @remarks
 * Best-effort by design: stack formats differ across runtimes, and a bundled or
 * minified app may yield nothing useful. A vague location beats throwing while
 * building an error message, so an unreadable stack degrades to a placeholder
 * rather than failing.
 *
 * @returns A `file:line:col` string, or `<unknown location>`.
 * @throws Never - falls back to a placeholder.
 * @typeParam None - this function has no generic type parameters.
 */
function callSite (): string {
  const stack = new Error('locate').stack
  if (stack === undefined) {
    return '<unknown location>'
  }
  // [0] is the Error line, [1] is callSite, [2] is claimName, [3] is
  // defineActivity/defineOrchestration, [4] is the consumer — the one we want.
  const frame = stack.split('\n', 5)[4]
  return frame === undefined ? '<unknown location>' : frame.trim().replace(/^at\s+/, '')
}
