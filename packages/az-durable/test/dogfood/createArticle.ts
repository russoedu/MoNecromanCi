/**
 * Reconstruction of the `createArticle` workflow. See ./README.md — this is
 * NOT the real workflow.
 *
 * @remarks
 * Reaches for, in order: a validated input boundary, sequential activities with
 * unrelated IO types, a HETEROGENEOUS TUPLE fan-out, a human approval raced
 * against a durable timer, a sub-orchestration, retry options, a union-typed
 * activity result that must be narrowed, and compensation in a `catch`.
 */
import type { InvocationContext } from '@azure/functions'
import { RetryOptions } from 'durable-functions'
import {
  activityTask,
  all,
  any,
  callActivity,
  callSubOrchestration,
  defineActivity,
  defineEvent,
  defineOrchestration,
  defineStatuses,
  eventTask,
  resultOf,
  setStatus,
  timerTask
} from '../../src/index'

/** The draft an editor submits. */
export interface ArticleDraft {
  readonly title: string
  readonly body: string
  readonly authorId: string
  readonly tags?: readonly string[]
}

/** What the store returns once the article exists. */
export interface StoredArticle {
  readonly id: string
  readonly etag: string
}

/** A moderation verdict — a union the orchestration must narrow after the call. */
export type Moderation =
  | { readonly verdict: 'approved' } |
  { readonly verdict: 'rejected'; readonly reasons: readonly string[] }

const validateDraft = defineActivity(
  'ValidateDraft',
  (input: ArticleDraft, _context: InvocationContext): { ok: true } => {
    if (input.title.length === 0) {
      throw new Error('empty title')
    }
    return { ok: true }
  }
)

const moderate = defineActivity(
  'ModerateDraft',
  async (input: ArticleDraft): Promise<Moderation> =>
    await (input.body.includes('spam')
      ? { verdict: 'rejected' as const, reasons: ['spam'] }
      : { verdict: 'approved' as const })
)

const renderHtml = defineActivity(
  'RenderHtml',
  (input: ArticleDraft): string => `<h1>${input.title}</h1>`
)

const buildSlug = defineActivity('BuildSlug', (input: string): string => input.toLowerCase())

const countWords = defineActivity('CountWords', (input: string): number => input.split(' ').length)

const store = defineActivity(
  'StoreArticle',
  async (input: {
    draft: ArticleDraft
    html: string
    slug: string
  }): Promise<StoredArticle> => await { id: `a-${input.slug}`, etag: 'W/"1"' }
)

const unpublish = defineActivity('Unpublish', (input: { id: string }): void => {
  void input
})

const notify = defineActivity(
  'NotifyAuthor',
  (input: { authorId: string; articleId: string | undefined }): void => {
    void input
  }
)

/** The index rebuild, extracted so the workflow delegates to a sub-orchestration. */
export const reindexArticle = defineOrchestration(
  'ReindexArticle',
  function * (context, input: { articleId: string; body: string }) {
    const words = yield * callActivity(context, countWords, input.body)
    return { articleId: input.articleId, words }
  }
)

const approved = defineEvent<{ approvedBy: string }>('ArticleApproved')

const statuses = defineStatuses({
  validating: 'validating',
  awaitingApproval: 'awaiting-approval',
  publishing: 'publishing',
  rolledBack: 'rolled-back'
})

/** One day, in milliseconds — the approval window. */
const APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000

/** Reconstruction of `createArticle`. */
export const createArticle = defineOrchestration(
  'CreateArticle',
  function * (context, input: ArticleDraft) {
    setStatus(context, statuses, 'validating')
    yield * callActivity(context, validateDraft, input)

    const moderation = yield * callActivity(context, moderate, input)
    // The union narrows here. Were this `any`, a misspelled `reasons` would
    // still compile — which is the whole point of the package.
    if (moderation.verdict === 'rejected') {
      return { published: false as const, reasons: moderation.reasons }
    }

    // Heterogeneous fan-out: two activities with different output types,
    // scheduled concurrently and destructured positionally.
    const [html, slug] = yield * all(context, [
      activityTask(context, renderHtml, input),
      activityTask(context, buildSlug, input.title)
    ])

    setStatus(context, statuses, 'awaitingApproval')
    // Human approval raced against a durable timer — the canonical pattern,
    // and the one that could not be written before `eventTask`/`timerTask`
    // existed. Identity comparison against the original task is how the SDK's
    // own documentation tells you to read the winner.
    const approvalTask = eventTask(context, approved)
    const deadline = timerTask(context, APPROVAL_WINDOW_MS)
    const winner = yield * any(context, [approvalTask, deadline])
    if (winner === deadline) {
      return { published: false as const, reasons: ['approval timed out'] }
    }
    // The race is decided, so the losing timer MUST be cancelled or the
    // instance stays alive until it expires.
    if (!deadline.isCompleted()) {
      deadline.cancel()
    }
    const approvedBy = resultOf(approvalTask).approvedBy

    setStatus(context, statuses, 'publishing')
    const stored = yield * callActivity(
      context,
      store,
      { draft: input, html, slug },
      new RetryOptions(1000, 3)
    )

    try {
      const index = yield * callSubOrchestration(context, reindexArticle, {
        articleId: stored.id,
        body: input.body
      })
      yield * callActivity(context, notify, {
        authorId: input.authorId,
        articleId: stored.id
      })
      return {
        published: true as const,
        id: stored.id,
        words: index.words,
        approvedBy
      }
    } catch {
      setStatus(context, statuses, 'rolledBack')
      yield * callActivity(context, unpublish, { id: stored.id })
      return { published: false as const, reasons: ['indexing failed'] }
    }
  }
)
