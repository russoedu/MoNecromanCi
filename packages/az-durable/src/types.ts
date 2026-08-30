import type {
  OrchestrationContext,
  RegisteredActivity,
  RegisteredOrchestration,
  Task
} from 'durable-functions'

/**
 * An activity with its input and output types attached.
 *
 * @remarks
 * `__input` and `__output` are **phantom**: never assigned, never read, and
 * erased at build time. They exist only to carry `TInput`/`TOutput` through the
 * type system, since `RegisteredActivity` is `(input?: unknown) => …` and
 * therefore forgets both.
 *
 * `__input` is written as a function *parameter* rather than a bare property so
 * that `TInput` is **contravariant**. That is not decoration: with a covariant
 * property, an activity accepting a wider input would be assignable where a
 * narrower one is expected, and the wrapper would accept calls the handler
 * cannot serve.
 *
 * @typeParam TInput - The JSON-serialisable input the activity accepts.
 * @typeParam TOutput - The awaited output the activity produces.
 */
export interface TypedActivity<TInput, TOutput> {
  /** The activity name as registered in the Function App, verbatim. */
  readonly name: string
  /** The value `durable-functions` returned from `app.activity`. */
  readonly registered: RegisteredActivity
  /** Phantom. Never assigned. Makes `TInput` contravariant. */
  readonly __input?: (input: TInput) => void
  /** Phantom. Never assigned. Carries `TOutput`. */
  readonly __output?: () => TOutput
}

/**
 * An orchestration with its input and output types attached.
 *
 * @remarks
 * Same phantom-member design as {@link TypedActivity}; see there for why
 * `__input` is a function parameter.
 *
 * @typeParam TInput - The JSON-serialisable input the orchestration accepts.
 * @typeParam TOutput - The value the orchestration returns.
 */
export interface TypedOrchestration<TInput, TOutput> {
  /** The orchestration name as registered in the Function App, verbatim. */
  readonly name: string
  /** The value `durable-functions` returned from `app.orchestration`. */
  readonly registered: RegisteredOrchestration
  /**
   * The handler, retained so `runWorkflow` can drive it directly.
   *
   * @remarks
   * The SDK keeps no accessible reference to the generator once registered, so
   * without this the testing harness would have to go through the Functions
   * host. Reading it outside `@mnci/az-durable/testing` is not supported.
   */
  readonly handler: (
    context: OrchestrationContext,
    input: TInput
  ) => Generator<Task, TOutput, unknown>
  /** Phantom. Never assigned. Makes `TInput` contravariant. */
  readonly __input?: (input: TInput) => void
  /** Phantom. Never assigned. Carries `TOutput`. */
  readonly __output?: () => TOutput
}

/**
 * A task that has been scheduled but not yet yielded, for fan-out.
 *
 * @remarks
 * Produced by `activityTask` and consumed by `all`/`any`. Holding the SDK
 * `Task` rather than yielding it immediately is what lets several activities
 * run concurrently.
 *
 * @typeParam TOutput - The output the task will produce.
 */
export interface TypedTask<TOutput> {
  /** The underlying SDK task. Yield it, or hand it to `all`/`any`. */
  readonly task: Task
  /** Phantom. Never assigned. Carries `TOutput`. */
  readonly __output?: () => TOutput
}
