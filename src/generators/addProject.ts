import { isManagedRepo, loadConfig } from '../engine/config'
import type { ProjectKind } from '../engine/types'
import { logger } from '../util/logger'
import { promptText, select } from '../util/prompts'
import { toSlug } from '../util/strings'
import { generateProject } from './scaffold'

export interface AddOptions {
  type?: string
  name?: string
}

/** Interactive `nx-magic add`: pick a project kind and scaffold it. */
export async function runAdd (options: AddOptions): Promise<void> {
  const repoRoot = process.cwd()

  if (!isManagedRepo(repoRoot)) {
    logger.error('No .nx-magic.json found here. Run this from the monorepo root, or create one with `nx-magic new`.')
    return
  }

  const config = loadConfig(repoRoot)
  if (!config) {
    logger.error('Could not read .nx-magic.json.')
    return
  }

  const kind = (options.type as ProjectKind | undefined) ?? await select<ProjectKind>({
    message: 'What do you want to add?',
    choices: [
      { name: 'Internal library', value: 'internal-lib' },
      { name: 'Publishable library', value: 'publishable-lib' },
      { name: 'CLI tool', value: 'cli-tool' },
      { name: 'Azure Function App', value: 'function-app' },
      { name: 'React app', value: 'react-app' },
    ],
  })

  const name = toSlug(options.name ?? await promptText('Project name'))
  generateProject(repoRoot, kind, name, config)
  logger.success('Done. Run `npm install` to link the new workspace, then `npm run graph`.')
}
