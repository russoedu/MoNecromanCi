import type { OrchestrationContext, Task } from 'durable-functions'
import type { TypedTimerTask } from './types'

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

/**
 * Schedules a durable timer for an absolute instant, without yielding it.
 *
 * @remarks
 * The task form of {@link sleepUntil}, so a timer can race an event or an
 * activity through `any`. See {@link TypedTimerTask} for why the returned
 * value carries `cancel` — **a pending timer keeps the instance alive**, so the
 * loser of a race must be cancelled.
 *
 * @param context - The orchestration context.
 * @param when - The instant to fire at.
 * @returns A cancellable timer task.
 * @throws Never - scheduling only.
 * @typeParam None - this function has no generic type parameters.
 */
export function timerTaskUntil (context: OrchestrationContext, when: Date): TypedTimerTask {
  const task = context.df.createTimer(when)
  return {
    task,
    cancel: () => {
      task.cancel()
    },
    isCompleted: () => task.isCompleted
  }
}

/**
 * Schedules a durable timer a fixed duration ahead, without yielding it.
 *
 * @remarks
 * Computes the deadline from `context.df.currentUtcDateTime`, never
 * `Date.now()` — the same replay-safety reason {@link sleepFor} does.
 *
 * @param context - The orchestration context.
 * @param ms - How far ahead to fire, in milliseconds.
 * @returns A cancellable timer task.
 * @throws Never - scheduling only.
 * @typeParam None - this function has no generic type parameters.
 */
export function timerTask (context: OrchestrationContext, ms: number): TypedTimerTask {
  return timerTaskUntil(context, new Date(now(context).getTime() + ms))
}
