/**
 * Tuple preservation for `all`, and the winner semantics for `any`.
 *
 * @remarks
 * The build plan calls tuple preservation "the easiest thing here to get subtly
 * wrong", and it is: a mapped type over `keyof T` that loses position degrades
 * `[string, number]` to `(string | number)[]` while still compiling. The
 * assertions below pin exact positions, not just membership.
 */
import type { OrchestrationContext, Task } from 'durable-functions'
import type { TypedTask } from '../../src/types'
import { all, any, resultOf } from '../../src/parallel'

declare const a: TypedTask<string>
declare const b: TypedTask<number>
declare const c: TypedTask<{ ok: boolean }>

/**
 * `all` returns outputs in the SAME POSITIONS, not a union array.
 *
 * @remarks
 * `first` and `second` are annotated with the exact expected types. If `all`
 * degraded to `(string | number)[]`, neither annotation would accept the value
 * and this stops compiling — which is the assertion.
 *
 * @param _c - Unused; an orchestration handler receives it.
 * @returns A generator, never driven.
 * @throws Never - never executed.
 * @typeParam None - this function has no generic type parameters.
 */
export function * tuplePositions (_c: OrchestrationContext): Generator<Task, void, unknown> {
  const context = _c
  const [first, second, third] = yield * all(context, [a, b, c])
  const s: string = first
  const n: number = second
  const o: boolean = third.ok
  void s; void n; void o
}

/**
 * A position may not be read as the wrong type.
 *
 * @remarks
 * The directive is the assertion. Position 0 is `string`; if `all` collapsed to
 * a union array this assignment would be legal and the directive unused.
 *
 * @param _c - Unused.
 * @returns A generator, never driven.
 * @throws Never - never executed.
 * @typeParam None - this function has no generic type parameters.
 */
export function * wrongPosition (_c: OrchestrationContext): Generator<Task, void, unknown> {
  const [first] = yield * all(_c, [a, b])
  // @ts-expect-error position 0 is string, not number
  const n: number = first
  void n
}

/**
 * `any` returns the WINNING TASK, identity-comparable against the input.
 *
 * @remarks
 * Not the output. `Task.any` is documented as returning "the first Task from
 * tasks to complete", and the SDK's own example compares it by identity. A
 * signature returning the output would hand back a `Task` while the compiler
 * believed otherwise.
 *
 * @param _c - Unused.
 * @returns A generator, never driven.
 * @throws Never - never executed.
 * @typeParam None - this function has no generic type parameters.
 */
export function * anyReturnsWinner (_c: OrchestrationContext): Generator<Task, void, unknown> {
  const winner = yield * any(_c, [a, b])
  if (winner === a) {
    const s: string = resultOf(a)
    void s
  }
}

/**
 * `any`'s winner is not the output type.
 *
 * @remarks
 * Guards the exact mistyping the build plan's original signature would have
 * introduced.
 *
 * @param _c - Unused.
 * @returns A generator, never driven.
 * @throws Never - never executed.
 * @typeParam None - this function has no generic type parameters.
 */
export function * anyIsNotOutput (_c: OrchestrationContext): Generator<Task, void, unknown> {
  const winner = yield * any(_c, [a, b])
  // @ts-expect-error the winner is a task, not the string output
  const s: string = winner
  void s
}
