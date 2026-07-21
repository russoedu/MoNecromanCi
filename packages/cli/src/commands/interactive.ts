import { join } from 'node:path'
import { select } from '@inquirer/prompts'
import { fileExists } from '../util/fsx'
import { runAdd } from './add'
import { runNew } from './new'

/** The two things the wizard can start: scaffold a workspace, or add to one. */
type InteractiveAction = 'new' | 'add'

/**
 * Runs the guided wizard shown when `mnci2` is invoked with no arguments.
 *
 * @remarks
 * A thin dispatcher: it picks between the two commands, then hands off to the
 * existing flows — {@link runNew} and {@link runAdd} — which already prompt for
 * every field they need (name/scope/registry/agent/variable group for `new`;
 * kind/name, and the npm-lib scope on this bare path, for `add`). Nothing about
 * the prompting lives here, so the wizard and the flag-driven commands can
 * never drift.
 *
 * The menu is ordered by context: inside a workspace (an `nx.json` in the cwd)
 * `add` is offered first, otherwise `new` — so the default highlight matches
 * what the user most likely wants. Both are always shown; picking `add`
 * outside a workspace surfaces {@link runAdd}'s clear "run from the workspace
 * root" error.
 *
 * @param None - this function takes no parameters.
 * @returns A promise that resolves when the chosen flow completes.
 * @throws Propagates prompt errors and any failure from the dispatched flow.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runInteractive (): Promise<void> {
  const inWorkspace = fileExists(join(process.cwd(), 'nx.json'))
  const newChoice = { name: 'Create a new monorepo', value: 'new' as const }
  const addChoice = { name: 'Add a project to this workspace', value: 'add' as const }

  const action = await select<InteractiveAction>({
    message: 'What would you like to do?',
    choices: inWorkspace ? [addChoice, newChoice] : [newChoice, addChoice],
  })

  if (action === 'new') {
    await runNew(undefined, {})
  } else {
    await runAdd(undefined, undefined, {})
  }
}
