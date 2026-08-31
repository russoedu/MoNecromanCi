import { callActivity } from './activity'
import { defineActivity } from './activity'
import { defineEvent, eventTask } from './events'
import { defineOrchestration } from './orchestration'
import { any } from './parallel'
import { timerTask } from './time'
import { defineStatuses, setStatus } from './status'
import { resetRegistryForTests } from './registry'
import { runWorkflow } from './testing'

const STATUSES = defineStatuses({ validating: 'Validating', storing: 'Storing', done: 'Done' })

/** Builds the three-step workflow fresh, so the name registry stays clean per test. */
function buildWorkflow () {
  resetRegistryForTests()
  const validate = defineActivity(
    'validate',
    (input: { title: string }): { ok: boolean } => ({ ok: input.title.length > 0 })
  )
  const store = defineActivity('store', (input: { title: string }): { id: string } => ({
    id: `id-${input.title}`
  }))
  const finalise = defineActivity('finalise', (input: { id: string }): { url: string } => ({
    url: `https://example.test/${input.id}`
  }))

  const articleWorkflow = defineOrchestration(
    'createArticle',
    function * (context, input: { title: string }) {
      setStatus(context, STATUSES, 'validating')
      const validated = yield * callActivity(context, validate, { title: input.title })
      if (!validated.ok) {
        // The short-circuit branch: storage is still finalised, which is
        // exactly the behaviour that was awkward to test before.
        setStatus(context, STATUSES, 'done')
        return { url: null as string | null }
      }
      setStatus(context, STATUSES, 'storing')
      const stored = yield * callActivity(context, store, { title: input.title })
      const done = yield * callActivity(context, finalise, { id: stored.id })
      setStatus(context, STATUSES, 'done')
      return { url: done.url }
    }
  )
  return { articleWorkflow }
}

describe('runWorkflow', () => {
  it('drives a three-step workflow with no Azure running', () => {
    const { articleWorkflow } = buildWorkflow()
    const run = runWorkflow(articleWorkflow, { title: 'hello' }, {
      activities: {
        validate: () => ({ ok: true }),
        store: () => ({ id: 'id-hello' }),
        finalise: () => ({ url: 'https://example.test/id-hello' })
      }
    })

    expect(run.result).toEqual({ url: 'https://example.test/id-hello' })
    // Ordering is the assertion, not membership: reordering activity calls is a
    // breaking change to an orchestration's replay history.
    expect(run.calls.map(c => c.name)).toEqual(['validate', 'store', 'finalise'])
    expect(run.calls[1]?.input).toEqual({ title: 'hello' })
    expect(run.statuses).toEqual(['Validating', 'Storing', 'Done'])
  })

  it('takes the short-circuit branch and still finalises status', () => {
    const { articleWorkflow } = buildWorkflow()
    const run = runWorkflow(articleWorkflow, { title: '' }, {
      activities: { validate: () => ({ ok: false }) }
    })

    expect(run.result).toEqual({ url: null })
    expect(run.calls.map(c => c.name)).toEqual(['validate'])
    expect(run.statuses).toEqual(['Validating', 'Done'])
  })

  it('makes an activity throw when its stub returns an Error', () => {
    // Returning an Error is how failure branches become testable. If the stub
    // merely RETURNED the error, the orchestration would treat it as a value
    // and the failure path would never run.
    const { articleWorkflow } = buildWorkflow()
    expect(() =>
      runWorkflow(articleWorkflow, { title: 'x' }, {
        activities: {
          validate: () => ({ ok: true }),
          store: () => new Error('storage unavailable')
        }
      })
    ).toThrow('storage unavailable')
  })

  it('marks the race winner completed and leaves the loser pending', () => {
    // Mutation testing found `isCompleted = true` on the winner observed by
    // nothing. It is not decoration: production code reads it to decide
    // whether a losing timer still needs cancelling, so a harness that left
    // the winner pending would send a test down the opposite branch.
    resetRegistryForTests()
    const signal = defineEvent<{ ok: boolean }>('signal')
    const seen: Array<[boolean, boolean]> = []
    const workflow = defineOrchestration('racing', function * (context, _input: null) {
      const waiter = eventTask(context, signal)
      const deadline = timerTask(context, 1000)
      const winner = yield * any(context, [waiter, deadline])
      seen.push([winner === deadline, deadline.isCompleted()])
      return { timedOut: winner === deadline }
    })

    const run = runWorkflow(workflow, null, {
      activities: { signal: () => ({ ok: true }) },
      raceWinner: names => names.find(n => n === '__timer') ?? names[0]
    })
    expect(run.result).toEqual({ timedOut: true })
    expect(seen).toEqual([[true, true]])
  })

  it("injects the stub's Error INTO the orchestration, so a catch can handle it", () => {
    // The guard the original test was missing. Asserting only that
    // `runWorkflow` throws passes whether the error is injected into the
    // generator or merely thrown by the driver — and it was the latter, so
    // every compensation branch was unreachable while the docstring promised
    // otherwise. Only an orchestration that CATCHES can tell the two apart.
    resetRegistryForTests()
    const risky = defineActivity('risky', (input: { id: string }) => input.id)
    const compensate = defineActivity('compensate', (input: { id: string }) => input.id)
    const workflow = defineOrchestration('compensating', function * (context, input: { id: string }) {
      try {
        yield * callActivity(context, risky, input)
        return { recovered: false }
      } catch {
        yield * callActivity(context, compensate, input)
        return { recovered: true }
      }
    })

    const run = runWorkflow(workflow, { id: 'x' }, {
      activities: {
        risky: () => new Error('boom'),
        compensate: () => 'x'
      }
    })
    expect(run.result).toEqual({ recovered: true })
    expect(run.calls.map(c => c.name)).toEqual(['risky', 'compensate'])
  })

  it('names the activity when a stub is missing', () => {
    const { articleWorkflow } = buildWorkflow()
    expect(() =>
      runWorkflow(articleWorkflow, { title: 'x' }, { activities: { validate: () => ({ ok: true }) } })
    ).toThrow(/No stub registered for 'store'/)
  })

  it('fixes the clock so time-dependent output is deterministic', () => {
    resetRegistryForTests()
    const stamp = defineOrchestration('stamped', function * (context, _input: void) {
      const at = context.df.currentUtcDateTime
      yield * []
      return at.toISOString()
    })
    const run = runWorkflow(stamp, undefined, {
      activities: {},
      now: new Date('2020-01-01T00:00:00.000Z')
    })
    expect(run.result).toBe('2020-01-01T00:00:00.000Z')
  })
})
