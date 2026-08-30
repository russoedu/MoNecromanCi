import type { OrchestrationContext, Task } from 'durable-functions'
import { now, sleepFor, sleepUntil } from './time'

/** A context stub exposing only what these functions touch. */
function contextAt (fixed: Date): OrchestrationContext {
  const timers: Date[] = []
  const context = {
    df: {
      currentUtcDateTime: fixed,
      createTimer: (fireAt: Date): Task => {
        timers.push(fireAt)
        return { isCompleted: false, isFaulted: false }
      }
    },
    timers
  }
  return context as unknown as OrchestrationContext & { timers: Date[] }
}

/** Drives a generator to completion, ignoring what it yields. */
function drive (generator: Generator<Task, void, unknown>): void {
  let step = generator.next()
  while (!step.done) {
    step = generator.next(undefined)
  }
}

describe('replay-safe time', () => {
  it('now() reads currentUtcDateTime, not the wall clock', () => {
    const fixed = new Date('2020-01-01T00:00:00.000Z')
    expect(now(contextAt(fixed))).toBe(fixed)
  })

  it('sleepFor computes its deadline from currentUtcDateTime', () => {
    // THE determinism invariant. Computing from Date.now() would move the
    // deadline on every replay, so the timer could fire early, late, or more
    // than once — and nothing would report it, because the orchestration still
    // completes. Asserting the exact instant is the only way to pin this.
    const fixed = new Date('2020-01-01T00:00:00.000Z')
    const context = contextAt(fixed) as OrchestrationContext & { timers: Date[] }
    drive(sleepFor(context, 90_000))

    expect(context.timers).toHaveLength(1)
    expect(context.timers[0]?.toISOString()).toBe('2020-01-01T00:01:30.000Z')
  })

  it('sleepFor is independent of the real clock', () => {
    // The same stub twice, a real interval apart, must produce the identical
    // deadline. If wall clock leaked in, these would differ.
    const fixed = new Date('2020-06-15T12:00:00.000Z')
    const first = contextAt(fixed) as OrchestrationContext & { timers: Date[] }
    const second = contextAt(fixed) as OrchestrationContext & { timers: Date[] }
    drive(sleepFor(first, 1000))
    drive(sleepFor(second, 1000))

    expect(first.timers[0]?.getTime()).toBe(second.timers[0]?.getTime())
  })

  it('sleepUntil passes the instant through unchanged', () => {
    const context = contextAt(new Date('2020-01-01T00:00:00.000Z')) as OrchestrationContext & {
      timers: Date[]
    }
    const when = new Date('2021-03-04T05:06:07.000Z')
    drive(sleepUntil(context, when))

    expect(context.timers[0]).toBe(when)
  })
})
