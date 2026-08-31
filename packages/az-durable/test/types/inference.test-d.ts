/**
 * The package's reason to exist, asserted at the type level.
 *
 * @remarks
 * The `@ts-expect-error` directives ARE the test. If inference collapses to
 * `any`, no error is produced, TypeScript reports each directive as unused, and
 * the build fails — which is the desired behaviour. Deleting any one of them
 * must fail this file; that is checked by mutation, not assumed.
 */
import type { OrchestrationContext, Task } from 'durable-functions'
import type { TypedActivity } from '../../src/types'
import { callActivity } from '../../src/activity'

// Declared rather than defined: `defineActivity` registers with the SDK, and a
// type test must not need a Function App host.
declare const probe: TypedActivity<{ id: string }, { count: number }>

/**
 * The whole point: inference flows through `yield *` delegation.
 *
 * @remarks
 * A generator has ONE `TNext` shared by every `yield`, so a per-call result
 * type is impossible that way. `yield *` returns the delegated generator's
 * `TReturn`, which IS per-call generic — so `result.count` is a real `number`.
 *
 * @param _c - Unused; present because an orchestration handler receives it.
 * @returns A generator, never driven — this file is type-checked, not run.
 * @throws Never - never executed.
 * @typeParam None - this function has no generic type parameters.
 */
export function * happy (_c: OrchestrationContext): Generator<Task, number, unknown> {
  const result = yield * callActivity(_c, probe, { id: 'x' })
  const n: number = result.count
  return n
}

/**
 * An input of the wrong type must not compile.
 *
 * @remarks
 * Guards the contravariance of `__input`. Without it an activity accepting a
 * wider input would be assignable where a narrower one is expected.
 *
 * @param _c - Unused; present because an orchestration handler receives it.
 * @returns A generator, never driven — this file is type-checked, not run.
 * @throws Never - never executed.
 * @typeParam None - this function has no generic type parameters.
 */
export function * badInput (_c: OrchestrationContext): Generator<Task, void, unknown> {
  // @ts-expect-error wrong input type
  yield * callActivity(_c, probe, 42)
}

/**
 * The output must not be assignable to an unrelated type.
 *
 * @remarks
 * The directive is the assertion: if inference collapsed to `any`, the
 * assignment would succeed and TypeScript would report the directive itself
 * as unused, failing the build.
 *
 * @param _c - Unused; present because an orchestration handler receives it.
 * @returns A generator, never driven — this file is type-checked, not run.
 * @throws Never - never executed.
 * @typeParam None - this function has no generic type parameters.
 */
export function * badOutput (_c: OrchestrationContext): Generator<Task, void, unknown> {
  // @ts-expect-error wrong output assignment
  const s: string = yield * callActivity(_c, probe, { id: 'x' })
  void s
}

/**
 * A property absent from the output must not resolve.
 *
 * @remarks
 * The sharpest of the three — it fails if `TOutput` degrades to `any` even
 * when the assignment cases still happen to pass.
 *
 * @param _c - Unused; present because an orchestration handler receives it.
 * @returns A generator, never driven — this file is type-checked, not run.
 * @throws Never - never executed.
 * @typeParam None - this function has no generic type parameters.
 */
export function * badProp (_c: OrchestrationContext): Generator<Task, void, unknown> {
  const r = yield * callActivity(_c, probe, { id: 'x' })
  // @ts-expect-error property does not exist on output
  void r.nope
}
