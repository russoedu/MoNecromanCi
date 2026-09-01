import * as df from 'durable-functions'
import type { OrchestrationContext, RetryOptions, Task } from 'durable-functions'
import { claimName } from './registry.js'
import type { TypedOrchestration, TypedTask } from './types.js'

/**
 * The orchestration's handle on itself, handed to its own handler.
 *
 * @remarks
 * Exists so `continueAsNew` can be typed. See the member for why it cannot be
 * a free function.
 *
 * @typeParam TInput - This orchestration's input type.
 */
export interface OrchestrationSelf<TInput> {
  /** The orchestration's own registered name. */
  readonly name: string
  /**
   * Restarts this orchestration with fresh input, discarding its history.
   *
   * @remarks
   * Handed to the handler rather than exported as a free function, and that is
   * the whole design: `continueAsNew` restarts **this** orchestration, so its
   * argument must be this orchestration's own `TInput`. A free
   * `continueAsNew(context, input)` could only be generic on a type nothing
   * constrains, so it would accept any shape at all — precisely the unchecked
   * cast this package exists to remove. Referring to the orchestration
   * constant from inside its own handler is not an option either: it is not
   * initialised yet.
   *
   * The call does not by itself end the generator. Return immediately after
   * it, as the SDK requires; anything scheduled afterwards is discarded when
   * the instance restarts.
   */
  readonly continueAsNew: (input: TInput) => void
}

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
    input: TInput,
    self: OrchestrationSelf<TInput>
  ) => Generator<Task, TOutput, unknown>,
  options?: DefineOrchestrationOptions<TInput>
): TypedOrchestration<TInput, TOutput> {
  claimName('orchestration', name)
  const parse = options?.parse
  const bind = (context: OrchestrationContext): OrchestrationSelf<TInput> => ({
    name,
    continueAsNew: (next: TInput) => {
      context.df.continueAsNew(next)
    }
  })
  const registered = df.app.orchestration(name, function * (context: OrchestrationContext) {
    const raw: unknown = context.df.getInput()
    const input = parse === undefined ? (raw as TInput) : parse(raw)
    return yield * handler(context, input, bind(context))
  })
  return {
    name,
    registered,
    handler: (context, input) => handler(context, input, bind(context))
  }
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
  const result = yield subOrchestrationTask(context, orchestration, input, options).task
  return result as TOutput
}

/**
 * Schedules a sub-orchestration without yielding it.
 *
 * @remarks
 * The task form of {@link callSubOrchestration}, so several sub-orchestrations
 * can run concurrently through `all`. Fanning out over sub-orchestrations is
 * the standard way to bound a large batch — each child gets its own history,
 * so the parent's history does not grow with the batch size.
 *
 * @param context - The orchestration context.
 * @param orchestration - The sub-orchestration to schedule.
 * @param input - Its input, checked against its declared type.
 * @param options - Optional fixed instance id and retry policy.
 * @returns A task carrying the sub-orchestration's output type.
 * @throws Never - scheduling only.
 * @typeParam TInput - The sub-orchestration's input type.
 * @typeParam TOutput - The sub-orchestration's output type.
 */
export function subOrchestrationTask<TInput, TOutput> (
  context: OrchestrationContext,
  orchestration: TypedOrchestration<TInput, TOutput>,
  input: TInput,
  options?: { instanceId?: string; retry?: RetryOptions }
): TypedTask<TOutput> {
  const retry = options?.retry
  const task =
    retry === undefined
      ? context.df.callSubOrchestrator(orchestration.name, input, options?.instanceId)
      : context.df.callSubOrchestratorWithRetry(
          orchestration.name,
          retry,
          input,
          options?.instanceId
        )
  return { task }
}
