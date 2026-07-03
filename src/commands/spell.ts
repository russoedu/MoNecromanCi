import { changedProjects } from '../engine/changes'
import { isManagedRepo } from '../engine/config'
import { logger } from '../util/logger'

/**
 * `monecromanci spell`: list the changed projects to help write the commit.
 *
 * @remarks
 * Reads the repo's uncommitted changes (staged, unstaged and untracked) and
 * groups them by project — deliberately based on which files you touched, not
 * `nx affected` (which also includes downstream projects you would not put in
 * a commit scope). Prints each project with its changed files and a ready-made
 * conventional-commit scope suggestion.
 *
 * @param None - this function takes no parameters.
 * @returns A promise that resolves once the report has been printed.
 * @throws Propagates unexpected errors; the CLI entry point in `cli.ts`
 * catches and reports them (git failures are treated as "no changes").
 * @typeParam None - this function has no generic type parameters.
 */
export async function runSpell (): Promise<void> {
  const repoRoot = process.cwd()

  if (!isManagedRepo(repoRoot)) {
    logger.error('No .monecromanci.json found here. Run `spell` from a MoNecromanCI monorepo root.')
    return
  }

  const changes = changedProjects(repoRoot)

  if (changes.length === 0) {
    logger.success('The aether is calm — no uncommitted changes found.')
    return
  }

  logger.info('Changed projects:')
  for (const change of changes) {
    const location = change.path ? ` (${change.path})` : ''
    logger.info(`  ${change.name}${location} — ${change.files.length} file(s)`)
    for (const file of change.files) {
      logger.info(`      ${file}`)
    }
  }

  const scope = changes.map((change) => change.name).join(',')
  logger.success(`Suggested scope: ${scope}`)
  logger.info(`  e.g. feat(${scope}): <describe your change>`)
}
