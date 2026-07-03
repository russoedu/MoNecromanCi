import { GUIDE_FILE, syncGuide } from '../engine/guide'
import { logger } from '../util/logger'

/**
 * `monecromanci spellbook`: write (or refresh) the guide at the repo root.
 *
 * @remarks
 * Creates `MoNecromanCi.md` in the current directory — the same tool-owned
 * document every other command keeps in sync. Works in any directory (no
 * `.monecromanci.json` stamp required), so it can also seed the guide into a
 * repo that isn't managed yet.
 *
 * @param None - this function takes no parameters.
 * @returns A promise that resolves once the guide has been written.
 * @throws Propagates any Node.js `fs` error raised while writing the file, and
 * throws when the packaged assets directory cannot be located; the CLI entry
 * point in `cli.ts` catches and reports them.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runSpellbook (): Promise<void> {
  syncGuide(process.cwd())
  logger.success(`${GUIDE_FILE} written at the repo root.`)
}
