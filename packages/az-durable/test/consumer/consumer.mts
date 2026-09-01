// The ESM half of the compatibility claim. `.mts` is ALWAYS an ES module under
// nodenext, whatever the package's `type` field says, so this pins the ESM
// resolution path without a package.json that Nx might infer as a project.
//
// The package ships CommonJS only, so an ESM consumer reaches it through Node's
// CJS interop, and named imports work only if cjs-module-lexer can statically
// detect the exports in the emitted bundle. That is a property of the BUILD, not
// of the source, so it needs asserting here rather than in a spec.
//
// Either way it imports by package NAME, so resolution goes through `exports`/
// `types` to the BUILT dist exactly as an installed consumer would — unlike
// test/types/*.test-d.ts, which import from ../../src and cannot see a
// build-output defect at all. Compiled with skipLibCheck FALSE, so a malformed
// declaration is an error rather than silently ignored.
import { defineActivity } from '@mnci/az-durable'

/**
 * Resolves to `never` when `T` is `any`, and to `T` otherwise.
 *
 * @remarks
 * `0 extends 1 & T` is true only for `any`, because intersecting with `any`
 * collapses the check. Assigning a real value to `never` then fails, which turns
 * "the package degraded to `any`" into a compile error.
 *
 * Used instead of `@ts-expect-error` deliberately: that directive must sit on the
 * line directly above the declaration, which detaches the TSDoc this repo
 * requires — and a guard depending on a comment's position is one reformat away
 * from silently passing.
 */
type NotAny<T> = 0 extends 1 & T ? never : T

const activity = defineActivity('probe-esm', async (input: { id: string }) => ({
  title: input.id
}))

/**
 * The gate this fixture exists for.
 *
 * @remarks
 * With broken declarations and the `skipLibCheck: true` that consumers almost
 * universally set, every export resolves to `any`, the build stays green, and the
 * package's purpose — removing `any` from the orchestrator/activity boundary — is
 * silently inverted. This annotation fails the moment that happens, whatever
 * skipLibCheck is set to.
 */
export const activityName: NotAny<typeof activity.name> = activity.name
