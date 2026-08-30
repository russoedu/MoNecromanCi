import * as df from 'durable-functions'
import type { InvocationContext } from '@azure/functions'
import type { OrchestrationContext, RetryOptions, Task } from 'durable-functions'
import { claimName } from './registry'
import type { TypedActivity, TypedTask } from './types'

/**
 * Registers an activity and remembers its input and output types.
 *
 * @remarks
 * **Do not annotate `handler` as `ActivityHandler`.** That type is an alias for
 * `FunctionHandler`, which the SDK declares as
 * `(triggerInput: any, context: InvocationContext) => FunctionResult<any>` — so
 * annotating it discards the very signature this function exists to capture and
 * silently reduces the activity to `any` in and `any` out. The same applies to
 * any middleware wrapper typed `(h: ActivityHandler) => ActivityHandler`; make
 * such wrappers generic instead. Both traps are lintable — see the
 * `no-untyped-activity-handler` rule.
 *
 * `TOutput` is wrapped in `Awaited` so an `async` handler contributes its
 * resolved type rather than a `Promise`.
 *
 * @param name - The activity name, a literal. Never derived from a variable or
 * file name: it is baked into orchestration history, so a rename breaks every
 * in-flight instance.
 * @param handler - The activity implementation.
 * @returns The activity, carrying its input and output types.
 * @throws Error when `name` is already registered.
 * @typeParam TInput - The JSON-serialisable input.
 * @typeParam TOutput - The handler's return type, awaited.
 */
export function defineActivity<TInput, TOutput> (
  name: string,
  handler: (input: TInput, context: InvocationContext) => TOutput | Promise<TOutput>
): TypedActivity<TInput, Awaited<TOutput>> {
  claimName('activity', name)
  const registered = df.app.activity(name, {
    handler: handler as (input: unknown, context: InvocationContext) => unknown
  })
  return { name, registered }
}

/**
 * Schedules an activity without yielding it, for fan-out.
 *
 * @remarks
 * The single place in this package that schedules an activity. `callActivity`
 * is implemented in terms of it, so there is exactly one line to audit against
 * an SDK change.
 *
 * **Scheduled through `context`, not through `activity.registered`,** and the
 * two are equivalent — verified in the SDK source rather than assumed:
 *
 * ```
 * registered(input)             -> new AtomicTask(false, new CallActivityAction(name, input))
 * context.df.callActivity(...)  -> new AtomicTask(false, new CallActivityAction(name, input))
 * ```
 *
 * `RegisteredActivityTask` is an `AtomicTask` subclass that only ADDS
 * `withRetry`; the retry paths are identical too, both producing
 * `RetryableTask(AtomicTask(CallActivityWithRetryAction(...)))`. The action is
 * what enters orchestration history, so replay is unaffected.
 *
 * Routing through `context` is what makes {@link runWorkflow} possible without
 * reading `task.action.functionName` — an undocumented internal the package's
 * non-goals forbid depending on. It also makes every helper here uniformly
 * context-first.
 *
 * @param context - The orchestration context.
 * @param activity - The activity to schedule.
 * @param input - The input, checked against the activity's declared type.
 * @param retry - Optional retry policy.
 * @returns A scheduled task, for `all`/`any`.
 * @throws Never - scheduling is synchronous and cannot fail here.
 * @typeParam TInput - The activity's input type.
 * @typeParam TOutput - The activity's output type.
 */
export function activityTask<TInput, TOutput> (
  context: OrchestrationContext,
  activity: TypedActivity<TInput, TOutput>,
  input: TInput,
  retry?: RetryOptions
): TypedTask<TOutput> {
  const task =
    retry === undefined
      ? context.df.callActivity(activity.name, input)
      : context.df.callActivityWithRetry(activity.name, retry, input)
  return { task }
}

/**
 * Calls an activity and returns its typed result.
 *
 * @remarks
 * **Must be invoked with `yield*`, not `yield`.** The delegation is what carries
 * the type: `yield*` returns this generator's `TReturn`, which is per-call
 * generic, whereas a generator's `TNext` is shared by every `yield` and so can
 * never be typed per call. A bare `yield` is a compile error rather than a
 * silent `any` — `callActivity` returns a `Generator`, and yielding one where a
 * `Task` is expected does not typecheck — but the error message is obscure, so
 * prefer the lint rule's.
 *
 * Determinism is unaffected. The task yielded up to the Durable driver is the
 * identical object a hand-written call would yield, so replay history and
 * in-flight instances are untouched. This is a type-level change only.
 *
 * @param context - The orchestration context.
 * @param activity - The activity to call.
 * @param input - The input, checked against the activity's declared type.
 * @param retry - Optional retry policy.
 * @returns A generator to delegate to; its return value is the activity output.
 * @throws Whatever the activity threw, once the driver resumes with a failure.
 * @typeParam TInput - The activity's input type.
 * @typeParam TOutput - The activity's output type.
 */
export function * callActivity<TInput, TOutput> (
  context: OrchestrationContext,
  activity: TypedActivity<TInput, TOutput>,
  input: TInput,
  retry?: RetryOptions
): Generator<Task, TOutput, unknown> {
  const result = yield activityTask(context, activity, input, retry).task
  // The one cast in the package. The SDK resumes the generator with the
  // activity's result typed `any`; `TOutput` is the claim `defineActivity`
  // captured from the handler's real signature.
  return result as TOutput
}
