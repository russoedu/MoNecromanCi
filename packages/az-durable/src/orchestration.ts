import * as df from 'durable-functions'
import type { OrchestrationContext, RetryOptions, Task } from 'durable-functions'
import { claimName } from './registry'
import type { TypedOrchestration } from './types'

/**
 * Options accepted by {@link defineOrchestration}.
 *
 * @remarks
 * Only `parse` for now. Kept as an options object rather than a positional
 * argument so a later addition does not change the call signature of every
 * existing `defineOrchestration` call.
 *
 * @typeParam TInput - The orchestration's input type, which `parse` produces.
 */
export interface DefineOrchestrationOptions<TInput> {
  /**
   * Validates and narrows the raw input before the handler sees it.
   *
   * @remarks
   * Optional, and worth using. `context.df.getInput<T>()` is an **unchecked
   * cast** — `T` is a claim the SDK never verifies. That matters more here than
   * in ordinary code because orchestration input comes back out of the task hub:
   * an instance started by yesterday's deploy resumes against today's code, so a
   * shape change between deploys surfaces as a silently wrong object rather than
   * an error. A `parse` makes the claim real at the boundary.
   */
  readonly parse?: (raw: unknown) => TInput
}

/**
 * Registers an orchestration, handing the handler its deserialised input.
 *
 * @remarks
 * The SDK's `OrchestrationHandler` takes **only** `context` — there is no input
 * parameter — so this wrapper calls `getInput` itself and passes the result as a
 * second argument. That is why consumers never write
 * `context.df.getInput() as SomeType`.
 *
 * @param name - The orchestration name, a literal. Baked into history; never derive it.
 * @param handler - The orchestration generator, receiving context and input.
 * @param options - Optional input validation. See {@link DefineOrchestrationOptions}.
 * @returns The orchestration, carrying its input and output types.
 * @throws Error when `name` is already registered.
 * @typeParam TInput - The JSON-serialisable input.
 * @typeParam TOutput - The value the orchestration returns.
 */
export function defineOrchestration<TInput, TOutput> (
  name: string,
  handler: (
    context: OrchestrationContext,
    input: TInput
  ) => Generator<Task, TOutput, unknown>,
  options?: DefineOrchestrationOptions<TInput>
): TypedOrchestration<TInput, TOutput> {
  claimName('orchestration', name)
  const parse = options?.parse
  const registered = df.app.orchestration(name, function * (context: OrchestrationContext) {
    const raw: unknown = context.df.getInput()
    const input = parse === undefined ? (raw as TInput) : parse(raw)
    return yield * handler(context, input)
  })
  return { name, registered, handler }
}

/**
 * Calls a sub-orchestration and returns its typed result.
 *
 * @remarks
 * **Must be invoked with `yield*`.** See `callActivity` for why delegation is
 * what carries the type.
 *
 * @param orchestration - The sub-orchestration to call.
 * @param input - The input, checked against its declared type.
 * @param options - Optional instance id and retry policy.
 * @returns A generator to delegate to; its return value is the sub-orchestration output.
 * @throws Whatever the sub-orchestration threw, once the driver resumes with a failure.
 * @typeParam TInput - The sub-orchestration's input type.
 * @typeParam TOutput - The sub-orchestration's output type.
 */
export function * callSubOrchestration<TInput, TOutput> (
  context: OrchestrationContext,
  orchestration: TypedOrchestration<TInput, TOutput>,
  input: TInput,
  options?: { instanceId?: string; retry?: RetryOptions }
): Generator<Task, TOutput, unknown> {
  const retry = options?.retry
  const result = yield retry === undefined
    ? context.df.callSubOrchestrator(orchestration.name, input, options?.instanceId)
    : context.df.callSubOrchestratorWithRetry(
        orchestration.name,
        retry,
        input,
        options?.instanceId
      )
  return result as TOutput
}
