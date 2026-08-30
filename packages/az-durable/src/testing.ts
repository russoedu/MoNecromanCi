import type { OrchestrationContext, Task } from 'durable-functions'
import type { TypedOrchestration } from './types'

/**
 * A recorded activity or sub-orchestration call.
 *
 * @remarks
 * The ORDER of these is what replay compatibility depends on, which is why the
 * harness returns them as a list rather than a set: reordering two activity
 * calls is a breaking change to an orchestration, and this is what makes that
 * directly assertable.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface RecordedCall {
  /** The activity or orchestration name, as scheduled. */
  readonly name: string
  /** The input it was scheduled with. */
  readonly input: unknown
}

/**
 * What a stubbed activity returns, or an `Error` to make it throw.
 *
 * @remarks
 * Deliberately `unknown` rather than generic: a stub map covers many activities
 * with different outputs, so a single parameter could only be their union,
 * which is less useful than an explicit cast at the one place it matters.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type StubResult = unknown

/**
 * The fakes a workflow run is driven against.
 *
 * @remarks
 * `activities` is keyed by the same name literal `defineActivity` registered —
 * deliberately, since that string is the contract the task hub stores.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface WorkflowStub {
  /**
   * Result per activity name. Returning an `Error` instance makes that call
   * THROW inside the orchestration, which is how failure branches and
   * retry-exhaustion paths become testable.
   */
  readonly activities: Record<string, (input: unknown) => StubResult>
  /** Fixed clock, so time-dependent output is deterministic. Defaults to the epoch. */
  readonly now?: Date
  /** Instance id the orchestration sees. Defaults to `test-instance`. */
  readonly instanceId?: string
}

/**
 * What a completed {@link runWorkflow} reports.
 *
 * @remarks
 * `calls` and `statuses` are ordered lists rather than sets because the order
 * is the property worth asserting: it is what replay compatibility depends on.
 *
 * @typeParam TOutput - The orchestration's return type.
 */
export interface WorkflowRun<TOutput> {
  /** The orchestration's return value. */
  readonly result: TOutput
  /** Every activity and sub-orchestration call, in order. */
  readonly calls: RecordedCall[]
  /** Every `setCustomStatus` transition, in order. */
  readonly statuses: string[]
}

/** A task the fake context hands back; carries what was scheduled. */
interface FakeTask extends Task {
  readonly __name: string
  readonly __input: unknown
}

/**
 * Runs an orchestration against stubbed activities, with no Azure running.
 *
 * @remarks
 * Drives the generator synchronously, feeding each yielded task the stubbed
 * result for that activity's name. There is no host, no emulator and no
 * storage — a three-step workflow with a short-circuit branch is testable in
 * about fifteen lines.
 *
 * **How it intercepts.** The orchestration is driven with a fake
 * `OrchestrationContext`, which works only because every scheduling call in
 * this package goes through `context.df` rather than through the registered
 * callable. The alternative — reading the name off `task.action.functionName` —
 * is an undocumented SDK internal the package's non-goals forbid.
 *
 * **Limits, stated rather than discovered later.** Retry policies are not
 * simulated: a stub returning an `Error` throws once, it does not exhaust
 * attempts. `Task.any` resolves to the FIRST task in the list, since there is
 * no real concurrency to race. Timers complete immediately.
 *
 * @param orchestration - The orchestration to run.
 * @param input - The input, checked against its declared type.
 * @param stub - The activity fakes, clock and instance id.
 * @returns The result, the ordered calls, and the status transitions.
 * @throws Error when an activity is called with no stub registered for it.
 * @typeParam TInput - The orchestration's input type.
 * @typeParam TOutput - The orchestration's output type.
 */
export function runWorkflow<TInput, TOutput> (
  orchestration: TypedOrchestration<TInput, TOutput>,
  input: TInput,
  stub: WorkflowStub
): WorkflowRun<TOutput> {
  const calls: RecordedCall[] = []
  const statuses: string[] = []
  const clock = stub.now ?? new Date(0)

  const schedule = (name: string, scheduledInput: unknown): FakeTask => {
    calls.push({ name, input: scheduledInput })
    return { isCompleted: false, isFaulted: false, __name: name, __input: scheduledInput }
  }

  const context = {
    df: {
      instanceId: stub.instanceId ?? 'test-instance',
      isReplaying: false,
      currentUtcDateTime: clock,
      callActivity: schedule,
      callActivityWithRetry: (name: string, _retry: unknown, i: unknown) => schedule(name, i),
      callSubOrchestrator: (name: string, i: unknown) => schedule(name, i),
      callSubOrchestratorWithRetry: (name: string, _retry: unknown, i: unknown) =>
        schedule(name, i),
      waitForExternalEvent: (name: string) => schedule(name, undefined),
      // Timers complete immediately: there is no real time to wait for, and a
      // harness that blocked on one would be useless.
      createTimer: (fireAt: Date) => schedule('__timer', fireAt.toISOString()),
      setCustomStatus: (value: unknown) => {
        statuses.push(String(value))
      },
      Task: {
        all: (tasks: Task[]) => ({ isCompleted: false, isFaulted: false, __all: tasks }),
        // First, not fastest: there is no concurrency here to race.
        any: (tasks: Task[]) => tasks[0]
      }
    }
  } as unknown as OrchestrationContext

  const generator = orchestration.handler(context, input)
  let step = generator.next()
  while (!step.done) {
    step = generator.next(resolve(step.value, stub))
  }
  return { result: step.value, calls, statuses }
}

/**
 * Produces the value the driver resumes a yielded task with.
 *
 * @remarks
 * Separated so the `Task.all` fan-out case — where one yielded task stands for
 * several — is handled in one place rather than inline in the drive loop.
 *
 * @param task - The task the orchestration yielded.
 * @param stub - The stubs to resolve against.
 * @returns The value to resume with.
 * @throws The stub's `Error`, or an Error naming an activity with no stub.
 * @typeParam None - this function has no generic type parameters.
 */
function resolve (task: Task, stub: WorkflowStub): unknown {
  const fanOut = (task as { __all?: Task[] }).__all
  if (fanOut !== undefined) {
    return fanOut.map(t => resolve(t, stub))
  }
  const { __name: name, __input: input } = task as FakeTask
  if (name === '__timer') {
    return undefined
  }
  const activity = stub.activities[name]
  if (activity === undefined) {
    // Naming the activity matters: the alternative is `undefined` flowing into
    // the orchestration and failing somewhere unrelated.
    throw new Error(
      `No stub registered for '${name}'. Add it to stub.activities to run this workflow.`
    )
  }
  const result = activity(input)
  if (result instanceof Error) {
    // A returned Error becomes a THROWN error inside the orchestration, which
    // is what makes failure branches testable at all.
    throw result
  }
  return result
}
