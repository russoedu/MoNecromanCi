import { callActivity } from './activity'
import { defineActivity } from './activity'
import { defineOrchestration } from './orchestration'
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
