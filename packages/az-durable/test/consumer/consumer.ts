// A CONSUMER, not a spec. It imports the package by NAME, so resolution goes
// through `exports`/`types` to the BUILT dist exactly as an installed
// consumer's would — unlike test/types/*.test-d.ts, which import from ../../src
// and therefore cannot see a build-output defect at all.
//
// Compiled with skipLibCheck FALSE, so a malformed declaration is an ERROR
// rather than silently ignored. That catches TS2834 — an extensionless relative
// specifier in an ESM package — directly.
import { defineActivity } from '@mnci/az-durable'

/**
 * Resolves to `never` when `T` is `any`, and to `T` otherwise.
 *
 * @remarks
 * `0 extends 1 & T` is only true when `T` is `any`, because intersecting with
 * `any` collapses the check. Assigning a real value to `never` then fails, which
 * turns "the package degraded to `any`" into a compile error.
 *
 * Used instead of `@ts-expect-error` deliberately: that directive has to sit on
 * the line directly above the declaration, which detaches the TSDoc this repo
 * requires — and a guard that depends on a comment's position is a guard one
 * reformat away from silently passing.
 */
type NotAny<T> = 0 extends 1 & T ? never : T

const activity = defineActivity('probe', async (input: { id: string }) => ({
  title: input.id
}))

/**
 * The gate this fixture exists for.
 *
 * @remarks
 * With broken declarations and the `skipLibCheck: true` that consumers almost
 * universally set, every export resolves to `any`, the consumer's build stays
 * green, and the package's entire purpose — removing `any` from the
 * orchestrator/activity boundary — is silently inverted. This annotation fails
 * the moment that happens, whatever skipLibCheck is set to.
 */
export const activityName: NotAny<typeof activity.name> = activity.name
