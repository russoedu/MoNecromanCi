import { runDoctor } from './doctor'

/** Re-syncs tool-owned files to the latest templates (doctor with --fix). */
export async function runUpdate (): Promise<void> {
  await runDoctor({ apply: true })
}
