import { join, resolve } from 'node:path'
import { applyFiles, reportApply } from '../engine/apply'
import { configFromVars, saveConfig } from '../engine/config'
import { DEFAULT_BASE, DEFAULT_NODE_VERSION } from '../engine/constants'
import { fileExists } from '../engine/fsx'
import type { MonorepoVars } from '../engine/types'
import { monorepoFiles } from '../templates/monorepo'
import { logger } from '../util/logger'
import { confirm, promptText } from '../util/prompts'
import { toSlug } from '../util/strings'
import { generateProject } from './scaffold'

export interface NewOptions {
  name?:         string
  scope?:        string
  organization?: string
  project?:      string
  feed?:         string
  base?:         string
  /** Initial internal library name; empty string skips it. */
  lib?:          string
  /** Non-interactive: accept provided values and defaults without prompting. */
  yes?:          boolean
}

/** Interactive (or `--yes` non-interactive) `nx-magic new`: scaffold a monorepo. */
export async function runNew (options: NewOptions): Promise<void> {
  const yes = options.yes ?? false
  const ask = async (message: string, fallback: string, provided?: string): Promise<string> =>
    provided ?? (yes ? fallback : await promptText(message, fallback))

  const displayName = await ask('Monorepo name', 'My Monorepo', options.name)
  const workspaceName = toSlug(displayName)
  const scopeInput = await ask('npm scope', '@auto', options.scope)
  const scope = scopeInput.startsWith('@') ? scopeInput : `@${scopeInput}`
  const organization = await ask('Azure DevOps organization', 'my-org', options.organization)
  const project = await ask('Azure DevOps project', 'Automation', options.project)
  const artifactsFeed = await ask('Azure Artifacts feed', 'AUTO', options.feed)
  const defaultBase = await ask('Default git branch', DEFAULT_BASE, options.base)

  const targetDirectory = resolve(process.cwd(), workspaceName)
  if (fileExists(join(targetDirectory, 'package.json')) && !yes) {
    const overwrite = await confirm({ message: `${targetDirectory} already contains a package.json. Continue and overwrite tool-owned files?`, default: false })
    if (!overwrite) {
      logger.warn('Aborted.')
      return
    }
  }

  const vars: MonorepoVars = {
    workspaceName,
    displayName,
    scope,
    defaultBase,
    nodeVersion: DEFAULT_NODE_VERSION,
    azure:       { organization, project, artifactsFeed },
  }

  logger.step(`Creating monorepo in ${targetDirectory}`)
  reportApply(applyFiles(targetDirectory, monorepoFiles(vars)))
  saveConfig(targetDirectory, configFromVars(vars))

  const libName = await resolveInitialLib(options.lib, yes)
  if (libName) {
    generateProject(targetDirectory, 'internal-lib', libName, configFromVars(vars))
  }

  logger.success('Done. Next steps:')
  logger.info(`  cd ${workspaceName}`)
  logger.info('  npm install')
  logger.info(`  code "${displayName}.code-workspace"`)
}

/** Resolves the initial library name from flags/prompts (undefined = skip). */
async function resolveInitialLib (provided: string | undefined, yes: boolean): Promise<string | undefined> {
  if (provided !== undefined) {
    return provided === '' ? undefined : toSlug(provided)
  }
  if (yes) {
    return 'helpers'
  }

  const addLib = await confirm({ message: 'Add an initial internal library now?', default: true })
  return addLib ? toSlug(await promptText('Library name', 'helpers')) : undefined
}
