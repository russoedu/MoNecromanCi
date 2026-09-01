import type { DurableClient, OrchestrationContext, Task } from 'durable-functions'
import type { TypedTask } from './types.js'

/**
 * An external event name with its payload type attached.
 *
 * @remarks
 * `__payload` is phantom — never assigned, never read. Event names, like
 * activity names, are matched as strings by the runtime and must stay explicit
 * literals.
 *
 * @typeParam TPayload - The JSON-serialisable payload the event carries.
 */
export interface EventRef<TPayload> {
  /** The event name, verbatim. */
  readonly name: string
  /** Phantom. Never assigned. Carries `TPayload`. */
  readonly __payload?: () => TPayload
}

/**
 * Declares an external event and its payload type.
 *
 * @remarks
 * Deliberately does not register anything — external events have no
 * registration step in Durable Functions. This exists only to pair a name with
 * a payload type so the waiter and the raiser cannot disagree.
 *
 * @param name - The event name, a literal.
 * @returns The event reference.
 * @throws Never - constructs an object.
 * @typeParam TPayload - The payload type.
 */
export function defineEvent<TPayload> (name: string): EventRef<TPayload> {
  return { name }
}

/**
 * Waits for an external event and returns its typed payload.
 *
 * @remarks
 * **Must be invoked with `yield *`.**
 *
 * @param context - The orchestration context.
 * @param event - The event to wait for.
 * @returns A generator whose return value is the event payload.
 * @throws Never - resolves when the event arrives.
 * @typeParam TPayload - The payload type.
 */
export function * waitForEvent<TPayload> (
  context: OrchestrationContext,
  event: EventRef<TPayload>
): Generator<Task, TPayload, unknown> {
  const payload = yield eventTask(context, event).task
  return payload as TPayload
}

/**
 * Schedules a wait for an external event, without yielding it.
 *
 * @remarks
 * The task form of {@link waitForEvent}, and the reason it exists is a gap the
 * reconstructed workflows found: `any` and `all` take `TypedTask`s, so with
 * only the generator form the single most common Durable Functions pattern —
 * **wait for human approval, or time out** — could not be expressed at all.
 *
 * Pair it with {@link timerTask} and hand both to `any`.
 *
 * @param context - The orchestration context.
 * @param event - The event to wait for.
 * @returns A task carrying the event's payload type.
 * @throws Never - scheduling only.
 * @typeParam TPayload - The payload type.
 */
export function eventTask<TPayload> (
  context: OrchestrationContext,
  event: EventRef<TPayload>
): TypedTask<TPayload> {
  return { task: context.df.waitForExternalEvent(event.name) }
}

/**
 * Raises an external event to a waiting instance, with a checked payload.
 *
 * @remarks
 * The client half of {@link waitForEvent}. Pairing both sides through the same
 * `EventRef` is what stops the raiser and the waiter disagreeing about the
 * payload shape — the SDK types `eventData` as `unknown`, so nothing else would.
 *
 * @param client - The Durable client.
 * @param instanceId - The instance to signal.
 * @param event - The event being raised.
 * @param payload - The payload, checked against the event's declared type.
 * @returns A promise resolving when the event is enqueued.
 * @throws Propagates whatever the client throws.
 * @typeParam TPayload - The payload type.
 */
export async function raiseEvent<TPayload> (
  client: DurableClient,
  instanceId: string,
  event: EventRef<TPayload>,
  payload: TPayload
): Promise<void> {
  await client.raiseEvent(instanceId, event.name, payload)
}
