import { join } from 'node:path'
import { select } from '@inquirer/prompts'
import { fileExists } from '../util/fsx'
import { runAdd } from './add'
import { runNew } from './new'
import { runUpgrade } from './upgrade'

/** The three things the wizard can start: scaffold, add to, or upgrade a workspace. */
type InteractiveAction = 'new' | 'add' | 'upgrade'

/**
 * Runs the guided wizard shown when `mnci` is invoked with no arguments.
 *
 * @remarks
 * A thin dispatcher: it picks between the three commands, then hands off to
 * the existing flows — {@link runNew}, {@link runAdd} and {@link runUpgrade} —
 * which already handle every field they need (name/scope/registry/agent/
 * variable group for `new`; kind/name, and the npm-lib scope on this bare
 * path, for `add`; whatever `mnci new`/a previous upgrade persisted, for
 * `upgrade`). Nothing about the prompting or resolution lives here, so the
 * wizard and the flag-driven commands can never drift.
 *
 * The menu is ordered by context: inside a workspace (an `nx.json` in the cwd)
 * `add` is offered first, then `upgrade`, then `new` — so the default
 * highlight matches what the user most likely wants. All three are always
 * shown; picking `add` or `upgrade` outside a workspace surfaces that flow's
 * own clear "run from the workspace root" error.
 *
 * @param None - this function takes no parameters.
 * @returns A promise that resolves when the chosen flow completes.
 * @throws Propagates prompt errors and any failure from the dispatched flow.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runInteractive(): Promise<void> {
  const inWorkspace = fileExists(join(process.cwd(), 'nx.json'))
  const choiceNew = { name: 'Create a new monorepo', value: 'new' as const }
  const choiceAdd = { name: 'Add a project to this workspace', value: 'add' as const }
  const choiceUpgrade = {
    name: 'Upgrade this workspace (re-apply the latest overlay)',
    value: 'upgrade' as const,
  }

  const action = await select<InteractiveAction>({
    message: 'What would you like to do?',
    choices: inWorkspace
      ? [choiceAdd, choiceUpgrade, choiceNew]
      : [choiceNew, choiceAdd, choiceUpgrade],
  })

  if (action === 'new') {
    await runNew(undefined, {})
  } else if (action === 'upgrade') {
    runUpgrade(process.cwd(), {})
  } else {
    await runAdd(undefined, undefined, {})
  }
}
