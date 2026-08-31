/**
 * Reconstruction of the `resetSharePoint` workflow. See ./README.md — this is
 * NOT the real workflow.
 *
 * @remarks
 * The destructive-admin shape. Reaches for what the other two do not: a
 * `parse` boundary on orchestration input, a two-phase human confirmation, a
 * chain of activities where each output is the next one's input, and
 * compensation that runs on failure of any step.
 */
import {
  callActivity,
  defineActivity,
  defineEvent,
  defineOrchestration,
  defineStatuses,
  eventTask,
  resultOf,
  setStatus,
  timerTask
} from '../../src/index'
import { any } from '../../src/parallel'

/** The raw input, as it comes back out of the task hub. */
export interface ResetRequest {
  readonly siteUrl: string
  readonly requestedBy: string
  readonly dryRun: boolean
}

const snapshot = defineActivity(
  'SnapshotSite',
  (input: { siteUrl: string }): { snapshotId: string; itemCount: number } => ({
    snapshotId: `snap-${input.siteUrl}`,
    itemCount: 3
  })
)

const purgeLists = defineActivity(
  'PurgeLists',
  (input: { snapshotId: string }): { purged: number } => ({ purged: input.snapshotId.length })
)

const reprovision = defineActivity(
  'ReprovisionSite',
  (input: { snapshotId: string; purged: number }): { siteId: string } => ({
    siteId: `site-${input.purged}`
  })
)

const restoreSnapshot = defineActivity('RestoreSnapshot', (input: { snapshotId: string }): void => {
  void input
})

const confirmed = defineEvent<{ confirmedBy: string; ticket: string }>('ResetConfirmed')

const statuses = defineStatuses({
  awaitingConfirmation: 'awaiting-confirmation',
  snapshotting: 'snapshotting',
  purging: 'purging',
  reprovisioning: 'reprovisioning',
  restored: 'restored'
})

/** Confirmation window for a destructive reset. */
const CONFIRM_WINDOW_MS = 60 * 60 * 1000

/**
 * Validates the raw input at the boundary.
 *
 * @remarks
 * `context.df.getInput()` is an unchecked cast, and an instance started by
 * yesterday's deploy resumes against today's code — so for a workflow that
 * DELETES a site, guessing at the shape is not acceptable.
 *
 * @param raw - Whatever the task hub handed back.
 * @returns The validated request.
 * @throws Error when the shape does not match.
 * @typeParam None - this function has no generic type parameters.
 */
function parseResetRequest (raw: unknown): ResetRequest {
  const value = raw as Partial<ResetRequest> | null
  if (
    value == null ||
    typeof value.siteUrl !== 'string' ||
    typeof value.requestedBy !== 'string' ||
    typeof value.dryRun !== 'boolean'
  ) {
    throw new Error('resetSharePoint: input did not match ResetRequest')
  }
  return { siteUrl: value.siteUrl, requestedBy: value.requestedBy, dryRun: value.dryRun }
}

/** Reconstruction of `resetSharePoint`. */
export const resetSharePoint = defineOrchestration(
  'ResetSharePoint',
  function * (context, input: ResetRequest) {
    setStatus(context, statuses, 'awaitingConfirmation')
    const confirmation = eventTask(context, confirmed)
    const deadline = timerTask(context, CONFIRM_WINDOW_MS)
    const winner = yield * any(context, [confirmation, deadline])
    if (winner === deadline) {
      return { reset: false as const, reason: 'confirmation timed out' }
    }
    if (!deadline.isCompleted()) {
      deadline.cancel()
    }
    const { ticket } = resultOf(confirmation)

    setStatus(context, statuses, 'snapshotting')
    const snap = yield * callActivity(context, snapshot, { siteUrl: input.siteUrl })
    if (input.dryRun) {
      return { reset: false as const, reason: `dry run over ${snap.itemCount} items` }
    }

    try {
      setStatus(context, statuses, 'purging')
      // Chained: each activity's output is the next one's input, so a shape
      // change anywhere in the chain is a compile error at the seam.
      const purge = yield * callActivity(context, purgeLists, { snapshotId: snap.snapshotId })
      setStatus(context, statuses, 'reprovisioning')
      const site = yield * callActivity(context, reprovision, {
        snapshotId: snap.snapshotId,
        purged: purge.purged
      })
      return { reset: true as const, siteId: site.siteId, ticket }
    } catch {
      // Compensation. A destructive workflow that cannot roll back is not a
      // workflow, it is an incident.
      setStatus(context, statuses, 'restored')
      yield * callActivity(context, restoreSnapshot, { snapshotId: snap.snapshotId })
      return { reset: false as const, reason: 'reset failed; snapshot restored' }
    }
  },
  { parse: parseResetRequest }
)
