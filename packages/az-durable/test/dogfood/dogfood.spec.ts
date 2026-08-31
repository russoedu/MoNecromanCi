import { runWorkflow } from '../../src/testing'
import { cleanup } from './cleanup'
import { createArticle } from './createArticle'
import { resetSharePoint } from './resetSharePoint'

describe('reconstructed workflows (see ./README.md — NOT the real ones)', () => {
  describe('createArticle', () => {
    const stubs = {
      ValidateDraft: () => ({ ok: true }),
      ModerateDraft: () => ({ verdict: 'approved' }),
      RenderHtml: () => '<h1>t</h1>',
      BuildSlug: () => 'a-slug',
      ArticleApproved: () => ({ approvedBy: 'editor@example.com' }),
      StoreArticle: () => ({ id: 'a-1', etag: 'W/"1"' }),
      CountWords: () => 4,
      ReindexArticle: () => ({ articleId: 'a-1', words: 4 }),
      NotifyAuthor: () => undefined
    }
    const draft = { title: 'T', body: 'clean copy', authorId: 'u1' }

    it('publishes, and records every call in order', () => {
      const run = runWorkflow(createArticle, draft, { activities: stubs })
      expect(run.result).toEqual({
        published: true,
        id: 'a-1',
        words: 4,
        approvedBy: 'editor@example.com'
      })
      expect(run.calls.map(c => c.name)).toEqual([
        'ValidateDraft',
        'ModerateDraft',
        'RenderHtml',
        'BuildSlug',
        'ArticleApproved',
        '__timer',
        'StoreArticle',
        'ReindexArticle',
        'NotifyAuthor'
      ])
      expect(run.statuses).toEqual(['validating', 'awaiting-approval', 'publishing'])
    })

    it('short-circuits on a moderation rejection, scheduling nothing after it', () => {
      const run = runWorkflow(createArticle, draft, {
        activities: { ...stubs, ModerateDraft: () => ({ verdict: 'rejected', reasons: ['spam'] }) }
      })
      expect(run.result).toEqual({ published: false, reasons: ['spam'] })
      expect(run.calls.map(c => c.name)).toEqual(['ValidateDraft', 'ModerateDraft'])
    })

    it('abandons the article when approval never arrives', () => {
      // Reachable only because the harness lets the race be decided. With a
      // fixed winner this branch — and the one in resetSharePoint below, which
      // guards a DESTRUCTIVE action — could never be exercised.
      const run = runWorkflow(createArticle, draft, {
        activities: stubs,
        raceWinner: names => names.find(n => n === '__timer') ?? names[0]
      })
      expect(run.result).toEqual({ published: false, reasons: ['approval timed out'] })
      expect(run.calls.map(c => c.name)).not.toContain('StoreArticle')
    })

    it('compensates by unpublishing when indexing fails', () => {
      const run = runWorkflow(createArticle, draft, {
        activities: { ...stubs, ReindexArticle: () => new Error('index down'), Unpublish: () => undefined }
      })
      expect(run.result).toEqual({ published: false, reasons: ['indexing failed'] })
      expect(run.calls.map(c => c.name)).toContain('Unpublish')
      expect(run.statuses).toContain('rolled-back')
    })
  })

  describe('cleanup', () => {
    it('sweeps every batch and sums the bytes', () => {
      const stale = [
        { id: 'a', path: '/a', ageDays: 40 },
        { id: 'b', path: '/b', ageDays: 41 },
        { id: 'c', path: '/c', ageDays: 42 }
      ]
      const run = runWorkflow(
        cleanup,
        { olderThanDays: 30 },
        {
          activities: {
            ListStaleItems: () => stale,
            ArchiveItem: (i: unknown) =>
              (i as { id: string }).id === 'b' ? null : { archiveUrl: 'u' },
            CleanupBatch: () => ({ deleted: 2, bytes: 10 }),
            EmitAudit: () => undefined
          }
        }
      )
      expect(run.result).toEqual({ swept: 3, archived: 2, bytes: 20 })
      // Two batches of size 2 and 1, so exactly one pause between them.
      expect(run.calls.filter(c => c.name === '__timer')).toHaveLength(1)
      expect(run.calls.filter(c => c.name === 'CleanupBatch')).toHaveLength(2)
    })
  })

  describe('resetSharePoint', () => {
    const stubs = {
      ResetConfirmed: () => ({ confirmedBy: 'admin', ticket: 'INC-1' }),
      SnapshotSite: () => ({ snapshotId: 's-1', itemCount: 3 }),
      PurgeLists: () => ({ purged: 3 }),
      ReprovisionSite: () => ({ siteId: 'site-3' }),
      RestoreSnapshot: () => undefined
    }
    const request = { siteUrl: 'https://sp/site', requestedBy: 'admin', dryRun: false }

    it('resets after confirmation', () => {
      const run = runWorkflow(resetSharePoint, request, { activities: stubs })
      expect(run.result).toEqual({ reset: true, siteId: 'site-3', ticket: 'INC-1' })
    })

    it('does not reset when confirmation times out', () => {
      const run = runWorkflow(resetSharePoint, request, {
        activities: stubs,
        raceWinner: names => names.find(n => n === '__timer') ?? names[0]
      })
      expect(run.result).toEqual({ reset: false, reason: 'confirmation timed out' })
      expect(run.calls.map(c => c.name)).not.toContain('PurgeLists')
      expect(run.calls.map(c => c.name)).not.toContain('SnapshotSite')
    })

    it('stops before any destructive call on a dry run', () => {
      const run = runWorkflow(resetSharePoint, { ...request, dryRun: true }, { activities: stubs })
      expect(run.result).toEqual({ reset: false, reason: 'dry run over 3 items' })
      expect(run.calls.map(c => c.name)).not.toContain('PurgeLists')
    })

    it('restores the snapshot when reprovisioning fails', () => {
      const run = runWorkflow(resetSharePoint, request, {
        activities: { ...stubs, ReprovisionSite: () => new Error('quota') }
      })
      expect(run.result).toEqual({ reset: false, reason: 'reset failed; snapshot restored' })
      expect(run.calls.map(c => c.name)).toContain('RestoreSnapshot')
    })
  })
})
