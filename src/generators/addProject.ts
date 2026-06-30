import { isManagedRepo, loadConfig } from '../engine/config'
import type { ProjectKind } from '../engine/types'
import { logger } from '../util/logger'
import { promptText, select } from '../util/prompts'
import { toSlug } from '../util/strings'
import { generateProject } from './scaffold'

/**
 * Options accepted by {@link runAdd}.
 *
 * @remarks
 * Mirrors the CLI's `add <type> <name>` arguments.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface AddOptions {
  type?: string
  name?: string
}

/**
 * Interactive `monecromanci add`: pick a project kind and scaffold it.
 *
 * @remarks
 * Prompts for any value not supplied via `options`, then delegates to
 * {@link generateProject}.
 *
 * @param options - Project type/name supplied on the command line, if any.
 * @returns A promise that resolves once the project has been scaffolded.
 * @throws Propagates errors from the underlying file or config operations; the
 * CLI entry point in `cli.ts` catches and reports them.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runAdd (options: AddOptions): Promise<void> {
  const repoRoot = process.cwd()

  if (!isManagedRepo(repoRoot)) {
    logger.error('No .monecromanci.json found here. Run this from the monorepo root, or create one with `monecromanci new`.')
    return
  }

  const config = loadConfig(repoRoot)
  if (!config) {
    logger.error('Could not read .monecromanci.json.')
    return
  }

  const kind = (options.type as ProjectKind | undefined) ?? await select<ProjectKind>({
    message: 'What do you want to add?',
    choices: [
      { name: 'Internal library', value: 'internal-lib' },
      { name: 'Publishable library', value: 'publishable-lib' },
      { name: 'CLI tool', value: 'cli-tool' },
      { name: 'Azure Function App', value: 'function-app' },
      { name: 'Node.js app (generic server)', value: 'node-app' },
      { name: 'React app', value: 'react-app' },
      { name: 'Vue app', value: 'vue-app' },
      { name: 'Svelte app', value: 'svelte-app' },
      { name: 'Next.js app (full-stack)', value: 'nextjs-app' },
    ],
  })

  const name = toSlug(options.name ?? await promptText('Project name'))
  generateProject(repoRoot, kind, name, config)
  logger.success('Done. Run `npm install` to link the new workspace, then `npm run graph`.')
}
