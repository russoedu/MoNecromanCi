import type { OrchestrationContext, Task } from 'durable-functions'

/**
 * The current time, safely for replay.
 *
 * @remarks
 * `new Date()` and `Date.now()` return a different value on every replay, which
 * silently corrupts orchestration output rather than failing. `currentUtcDateTime`
 * is derived from orchestration history and returns the same value at the same
 * point every time. This is the replacement the lint rule suggests.
 *
 * @param context - The orchestration context.
 * @returns The replay-safe current time.
 * @throws Never - reads a property.
 * @typeParam None - this function has no generic type parameters.
 */
export function now (context: OrchestrationContext): Date {
  return context.df.currentUtcDateTime
}

/**
 * Sleeps until an absolute time.
 *
 * @remarks
 * **Must be invoked with `yield *`.**
 *
 * @param context - The orchestration context.
 * @param when - The absolute time to wake at.
 * @returns A generator that completes when the timer fires.
 * @throws Never - the timer either fires or the instance ends.
 * @typeParam None - this function has no generic type parameters.
 */
export function * sleepUntil (
  context: OrchestrationContext,
  when: Date
): Generator<Task, void, unknown> {
  yield context.df.createTimer(when)
}

/**
 * Sleeps for a duration.
 *
 * @remarks
 * The deadline is computed from {@link now}, **never** `Date.now()`. Using wall
 * clock here would make the deadline move on every replay, so a timer could fire
 * early, late, or repeatedly. This is the single most common determinism bug in
 * hand-written orchestrations.
 *
 * **Must be invoked with `yield *`.**
 *
 * @param context - The orchestration context.
 * @param ms - How long to sleep, in milliseconds.
 * @returns A generator that completes when the timer fires.
 * @throws Never - the timer either fires or the instance ends.
 * @typeParam None - this function has no generic type parameters.
 */
export function * sleepFor (
  context: OrchestrationContext,
  ms: number
): Generator<Task, void, unknown> {
  yield * sleepUntil(context, new Date(now(context).getTime() + ms))
}
