import type { OrchestrationContext } from 'durable-functions'
import { defineStatuses, setStatus } from './status.js'

describe('custom status', () => {
  it('sets the mapped value, not the key', () => {
    // `setCustomStatus` takes `unknown`, so passing the key by mistake is
    // invisible until someone reads an instance's status and finds 'running'
    // where 'Generating article' was meant.
    const statuses = defineStatuses({ running: 'Generating article', done: 'Complete' })
    const seen: unknown[] = []
    const context = {
      df: {
        setCustomStatus: (value: unknown) => {
          seen.push(value)
        }
      }
    } as unknown as OrchestrationContext

    setStatus(context, statuses, 'running')
    setStatus(context, statuses, 'done')

    expect(seen).toEqual(['Generating article', 'Complete'])
  })

  it('defineStatuses returns its argument unchanged', () => {
    // It is a typing device, not a transform. If it ever copies or freezes,
    // identity-based assertions elsewhere start lying.
    const input = { a: 'A' }
    expect(defineStatuses(input)).toBe(input)
  })
})
