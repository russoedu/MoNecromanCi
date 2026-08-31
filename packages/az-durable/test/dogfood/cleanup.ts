/**
 * Reconstruction of the `cleanup` workflow. See ./README.md — this is NOT the
 * real workflow.
 *
 * @remarks
 * The batch shape. Reaches for what `createArticle` does not: a fan-out whose
 * width is **not known at compile time** (an array, not a tuple), a
 * fan-out over SUB-orchestrations rather than activities, sequential batches
 * paced by a durable timer, an activity returning `void`, and nullable results
 * that must be filtered before use.
 */
import {
  activityTask,
  all,
  callActivity,
  callSubOrchestration,
  defineActivity,
  defineOrchestration,
  defineStatuses,
  setStatus,
  sleepFor,
  subOrchestrationTask
} from '../../src/index'

/** A row the sweep considers deleting. */
export interface StaleItem {
  readonly id: string
  readonly path: string
  readonly ageDays: number
}

const listStale = defineActivity(
  'ListStaleItems',
  (input: { olderThanDays: number }): StaleItem[] => [
    { id: '1', path: '/a', ageDays: input.olderThanDays + 1 }
  ]
)

const deleteItem = defineActivity(
  'DeleteItem',
  (input: { id: string }): { deleted: boolean; bytes: number } => ({
    deleted: true,
    bytes: input.id.length
  })
)

/** Returns `null` when the item was already gone — a nullable result to filter. */
const archiveItem = defineActivity(
  'ArchiveItem',
  (input: { id: string }): { archiveUrl: string } | null =>
    input.id === 'missing' ? null : { archiveUrl: `https://archive/${input.id}` }
)

/** A `void` activity: nothing to destructure, and it must still typecheck. */
const emitAudit = defineActivity('EmitAudit', (input: { batch: number; count: number }): void => {
  void input
})

const statuses = defineStatuses({
  listing: 'listing',
  sweeping: 'sweeping',
  done: 'done'
})

/** How many items one child orchestration handles. */
const BATCH_SIZE = 2
/** Pause between batches, so the sweep does not saturate the downstream API. */
const BATCH_PAUSE_MS = 5000

/** One batch, as its own orchestration — keeps the parent's history bounded. */
export const cleanupBatch = defineOrchestration(
  'CleanupBatch',
  function * (context, input: { items: readonly StaleItem[] }) {
    // Dynamic-width fan-out: `items.length` is a runtime value, so this is an
    // ARRAY of tasks, not a tuple. `all` must still carry the element type.
    const deletions = yield * all(
      context,
      input.items.map(item => activityTask(context, deleteItem, { id: item.id }))
    )
    const bytes = deletions.reduce((sum, d) => sum + d.bytes, 0)
    return { deleted: deletions.length, bytes }
  }
)

/** Reconstruction of `cleanup`. */
export const cleanup = defineOrchestration(
  'Cleanup',
  function * (context, input: { olderThanDays: number }) {
    setStatus(context, statuses, 'listing')
    const stale = yield * callActivity(context, listStale, input)

    // Nullable activity results, filtered before use.
    const archives = yield * all(
      context,
      stale.map(item => activityTask(context, archiveItem, { id: item.id }))
    )
    const archived = archives.filter((a): a is { archiveUrl: string } => a !== null)

    setStatus(context, statuses, 'sweeping')
    const batches: StaleItem[][] = []
    for (let i = 0; i < stale.length; i += BATCH_SIZE) {
      batches.push(stale.slice(i, i + BATCH_SIZE))
    }

    let totalBytes = 0
    let batchNumber = 0
    for (const batch of batches) {
      batchNumber += 1
      // Fan-out over SUB-orchestrations, again at runtime width.
      const results = yield * all(context, [
        subOrchestrationTask(context, cleanupBatch, { items: batch })
      ])
      totalBytes += results[0].bytes
      yield * callActivity(context, emitAudit, { batch: batchNumber, count: batch.length })
      if (batchNumber < batches.length) {
        yield * sleepFor(context, BATCH_PAUSE_MS)
      }
    }

    setStatus(context, statuses, 'done')
    return { swept: stale.length, archived: archived.length, bytes: totalBytes }
  }
)

void callSubOrchestration
