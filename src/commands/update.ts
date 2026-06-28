import { runDoctor } from './doctor'

/**
 * Re-syncs tool-owned files to the latest templates (doctor with --fix).
 *
 * @remarks
 * Thin wrapper around {@link runDoctor} that always applies fixes.
 *
 * @param None - this function takes no parameters.
 * @returns A promise that resolves once the repo's tool-owned files have been
 * repaired and the report logged.
 * @throws Propagates errors from {@link runDoctor}; the CLI entry point in
 * `cli.ts` catches and reports them.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runUpdate (): Promise<void> {
  await runDoctor({ apply: true })
}
