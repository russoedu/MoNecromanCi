import { join, resolve } from 'node:path'
import { applyFiles, reportApply } from '../engine/apply'
import { configFromVars, saveConfig } from '../engine/config'
import { DEFAULT_BASE, DEFAULT_NODE_VERSION } from '../engine/constants'
import { fileExists } from '../engine/fsx'
import type { CiProvider, MonorepoVars, RegistryConfig } from '../engine/types'
import { monorepoFiles } from '../templates/monorepo'
import { logger } from '../util/logger'
import { confirm, promptText, select } from '../util/prompts'
import { toSlug } from '../util/strings'
import { generateProject } from './scaffold'

/**
 * Options accepted by {@link runNew}.
 *
 * @remarks
 * Each field mirrors a CLI flag; omitted fields are prompted for unless `yes`
 * is set.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface NewOptions {
  name?:         string
  scope?:        string
  ci?:           CiProvider
  registry?:     RegistryConfig['kind']
  /** GitHub owner (org or user) for the `github-packages` registry. */
  owner?:        string
  organization?: string
  project?:      string
  feed?:         string
  base?:         string
  /** Initial internal library name; empty string skips it. */
  lib?:          string
  /** Non-interactive: accept provided values and defaults without prompting. */
  yes?:          boolean
}

/**
 * Interactive (or `--yes` non-interactive) `nx-magic new`: scaffold a monorepo.
 *
 * @remarks
 * Prompts for any value not supplied via `options` (unless `yes` is set):
 * name, CI provider, package registry (+ its fields), npm scope and base branch.
 * Then writes the monorepo template files and, optionally, an initial library.
 *
 * @param options - Monorepo inputs supplied on the command line, if any.
 * @returns A promise that resolves once the monorepo has been scaffolded.
 * @throws Propagates errors from the underlying file or config operations; the
 * CLI entry point in `cli.ts` catches and reports them.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runNew (options: NewOptions): Promise<void> {
  const yes = options.yes ?? false
  const ask = async (message: string, fallback: string, provided?: string): Promise<string> =>
    provided ?? (yes ? fallback : await promptText(message, fallback))
  const askChoice = async <T extends string>(message: string, choices: Array<{ name: string, value: T }>, fallback: T, provided?: T): Promise<T> =>
    provided ?? (yes ? fallback : await select<T>({ message, choices }))

  const displayName = await ask('Monorepo name', 'My Monorepo', options.name)
  const workspaceName = toSlug(displayName)

  const ci = await askChoice<CiProvider>('CI provider', [
    { name: 'Azure DevOps Pipelines', value: 'azure' },
    { name: 'GitHub Actions', value: 'github' },
    { name: 'Both', value: 'both' },
  ], 'azure', options.ci)

  const registry = await resolveRegistry(ci, options, ask, askChoice)

  const defaultScope = registry.kind === 'github-packages' ? `@${registry.owner}` : '@auto'
  const scopeInput = await ask('npm scope', defaultScope, options.scope)
  const scope = scopeInput.startsWith('@') ? scopeInput : `@${scopeInput}`
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
    ci,
    registry,
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

type AskText = (message: string, fallback: string, provided?: string) => Promise<string>
type AskChoice = <T extends string>(message: string, choices: Array<{ name: string, value: T }>, fallback: T, provided?: T) => Promise<T>

/** Resolves the registry config from flags/prompts (default keyed off the CI provider). */
async function resolveRegistry (ci: CiProvider, options: NewOptions, ask: AskText, askChoice: AskChoice): Promise<RegistryConfig> {
  const fallbackKind: RegistryConfig['kind'] = ci === 'github' ? 'github-packages' : 'azure-artifacts'
  const kind = await askChoice<RegistryConfig['kind']>('Package registry', [
    { name: 'Azure Artifacts', value: 'azure-artifacts' },
    { name: 'GitHub Packages', value: 'github-packages' },
    { name: 'Public npm', value: 'npm' },
  ], fallbackKind, options.registry)

  if (kind === 'azure-artifacts') {
    const organization = await ask('Azure DevOps organization', 'my-org', options.organization)
    const project = await ask('Azure DevOps project', 'Automation', options.project)
    const artifactsFeed = await ask('Azure Artifacts feed', 'AUTO', options.feed)
    return { kind, organization, project, artifactsFeed }
  }

  if (kind === 'github-packages') {
    const owner = await ask('GitHub owner (org or user)', 'my-org', options.owner)
    return { kind, owner }
  }

  return { kind: 'npm' }
}

/** Resolves the initial library name from flags/prompts (undefined = skip). */
async function resolveInitialLib (provided: string | undefined, shouldAcceptDefaults: boolean): Promise<string | undefined> {
  if (provided !== undefined) {
    return provided === '' ? undefined : toSlug(provided)
  }
  if (shouldAcceptDefaults) {
    return 'helpers'
  }

  const addLib = await confirm({ message: 'Add an initial internal library now?', default: true })
  return addLib ? toSlug(await promptText('Library name', 'helpers')) : undefined
}
