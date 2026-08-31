import type { OrchestrationContext, Task } from 'durable-functions'
import type { TypedTask } from './types'

/**
 * The outputs of a tuple of tasks, in the same positions.
 *
 * @remarks
 * Position preservation is the whole value: without it a `[string, number]`
 * fan-out degrades to `(string | number)[]` and every destructured binding
 * needs a cast, which is what the package exists to remove. `-readonly` strips
 * the modifier that `readonly [...T]` introduces, so the result is an ordinary
 * mutable tuple.
 *
 * @typeParam T - The tuple of tasks.
 */
export type TaskOutputs<T extends readonly TypedTask<unknown>[]> = {
  -readonly [K in keyof T]: T[K] extends TypedTask<infer O> ? O : never
}

/**
 * Waits for every task, preserving tuple positions.
 *
 * @remarks
 * **Must be invoked with `yield *`.** Takes `context` because `Task.all` is an
 * instance member of `context.df`, not a static — the build plan's
 * context-free signature cannot reach it.
 *
 * @param context - The orchestration context.
 * @param tasks - The scheduled tasks, as a tuple.
 * @returns A generator whose return value is the outputs, in input order.
 * @throws `AggregatedError` when any task failed, matching the SDK.
 * @typeParam T - The tuple of tasks.
 */
export function * all<T extends readonly TypedTask<unknown>[]> (
  context: OrchestrationContext,
  tasks: readonly [...T]
): Generator<Task, TaskOutputs<T>, unknown> {
  const results = yield context.df.Task.all(tasks.map(t => t.task))
  return results as TaskOutputs<T>
}

/**
 * Waits for the first task to complete and returns **which one won**.
 *
 * @remarks
 * Returns the winning task, not its result, because that is what the SDK does:
 * `Task.any` is documented as returning "the first Task from tasks to
 * complete", and the SDK's own example compares it by identity
 * (`if (winner === otherTask)`). The build plan's signature returned the
 * output type instead, which would hand back a `Task` at runtime while the
 * compiler believed it was the output — the exact class of silent mistyping
 * this package exists to prevent.
 *
 * The winner is mapped back to the `TypedTask` the caller passed, so `===`
 * against the original works. Read its value with {@link resultOf}.
 *
 * **Must be invoked with `yield *`.**
 *
 * @param context - The orchestration context.
 * @param tasks - The scheduled tasks.
 * @returns A generator whose return value is the winning task.
 * @throws Error when the SDK returns a task that was not one of the inputs.
 * @typeParam T - The tuple of tasks.
 */
export function * any<T extends readonly TypedTask<unknown>[]> (
  context: OrchestrationContext,
  tasks: readonly [...T]
): Generator<Task, T[number], unknown> {
  const won = yield context.df.Task.any(tasks.map(t => t.task))
  const winner = tasks.find(t => t.task === won)
  if (winner === undefined) {
    // Not defensive padding: if this ever fires, the SDK returned something
    // other than one of the tasks handed to it, and silently returning the
    // wrong element would misroute the branch the caller takes next.
    throw new Error('Task.any returned a task that was not one of the inputs.')
  }
  return winner
}

/**
 * Reads a completed task's result, typed.
 *
 * @remarks
 * `Task.result` is declared `unknown` by the SDK. This applies the output type
 * the `TypedTask` was carrying all along. Only meaningful after the task has
 * completed — typically on the winner from {@link any}.
 *
 * @param task - A completed task.
 * @returns Its result, typed as the task's output.
 * @throws Never - reads a property.
 * @typeParam TOutput - The task's output type.
 */
export function resultOf<TOutput> (task: TypedTask<TOutput>): TOutput {
  return task.task.result as TOutput
}
