import { confirm, select } from '../util/prompts'
import { runAdd } from './add'
import { runDoctor } from './doctor'
import { runNew } from './new'
import { runResurrect } from './resurrect'
import { runSpell } from './spell'
import { runSpellbook } from './spellbook'
import { runUpdate } from './update'
import { runValidate } from './validate'

/**
 * The commands the interactive menu can dispatch to.
 *
 * @remarks
 * One entry per CLI subcommand, plus `exit` to leave without doing anything.
 *
 * @typeParam None - this type has no generic type parameters.
 */
type MenuAction
  = | 'new'
    | 'add'
    | 'resurrect'
    | 'doctor'
    | 'update'
    | 'validate'
    | 'spell'
    | 'spellbook'
    | 'exit'

/**
 * Interactive mode: shown when the CLI is invoked with no arguments.
 *
 * @remarks
 * Presents every command as a menu (with its magic alias), then hands off to
 * the chosen command's own interactive flow. Commands that only take flags
 * (`doctor --fix`, `validate --all`) get a follow-up confirm instead of
 * requiring the flag.
 *
 * @param None - this function takes no parameters.
 * @returns A promise that resolves once the chosen command has finished (or
 * immediately when the user exits).
 * @throws Propagates errors from the dispatched command or the prompt (e.g.
 * when stdin is not a TTY); the CLI entry point in `cli.ts` catches and
 * reports them.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runInteractive (): Promise<void> {
  const action = await select<MenuAction>({
    message: 'What do you want to do?',
    choices: [
      { name: 'Summon — scaffold a brand-new monorepo (new)', value: 'new' },
      { name: 'Conjure — add a project to this monorepo (add)', value: 'add' },
      { name: 'Resurrect — adopt an existing monorepo (resurrect)', value: 'resurrect' },
      { name: 'Raise — detect and repair config drift (doctor)', value: 'doctor' },
      { name: 'Ascend — re-sync tool-owned files to the latest templates (update)', value: 'update' },
      { name: 'Ritual — run lint/test/build locally before pushing (validate)', value: 'validate' },
      { name: 'Spell — list changed projects as a ready-made commit scope (spell)', value: 'spell' },
      { name: 'Spellbook — write the MoNecromanCi.md guide at the repo root (spellbook)', value: 'spellbook' },
      { name: 'Exit', value: 'exit' },
    ],
  })

  switch (action) {
    case 'new': {
      await runNew({})
      return
    }
    case 'add': {
      await runAdd({})
      return
    }
    case 'resurrect': {
      await runResurrect()
      return
    }
    case 'doctor': {
      const apply = await confirm({ message: 'Apply fixes (--fix)? Choosing no only reports the drift.', default: false })
      await runDoctor({ apply })
      return
    }
    case 'update': {
      await runUpdate()
      return
    }
    case 'validate': {
      const all = await confirm({ message: 'Validate every project (--all)? Choosing no runs only affected projects.', default: false })
      await runValidate({ all })
      break
    }
    case 'spell': {
      await runSpell()
      break
    }
    case 'spellbook': {
      await runSpellbook()
      break
    }
    default: // 'exit' — nothing to do.
  }
}
