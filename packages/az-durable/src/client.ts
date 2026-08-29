import type { DurableClient } from 'durable-functions'
import type { TypedOrchestration } from './types'

/**
 * Starts an orchestration with an input checked against its declared type.
 *
 * @remarks
 * `DurableClient.startNew` takes the orchestration **name** and an options
 * object carrying `input`, both untyped. This narrows the pair so a caller
 * cannot start an orchestration with the wrong payload shape.
 *
 * @param client - The Durable client, from `df.getClient(context)`.
 * @param orchestration - The orchestration to start.
 * @param input - The input, checked against its declared type.
 * @param options - Optional instance id.
 * @returns The new instance id.
 * @throws Propagates whatever the client throws.
 * @typeParam TInput - The orchestration's input type.
 * @typeParam TOutput - The orchestration's output type, unused at runtime.
 */
export async function startOrchestration<TInput, TOutput> (
  client: DurableClient,
  orchestration: TypedOrchestration<TInput, TOutput>,
  input: TInput,
  options?: { instanceId?: string }
): Promise<string> {
  const instanceId = options?.instanceId
  return await client.startNew(orchestration.name, {
    input,
    ...(instanceId !== undefined && { instanceId })
  })
}
