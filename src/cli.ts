import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Command } from 'commander'
import { runAdd } from './commands/add'
import { runDoctor } from './commands/doctor'
import { runNew } from './commands/new'
import { runUpdate } from './commands/update'
import { logger } from './util/logger'
import type { CiProvider, RegistryConfig } from './engine/types'

/** Reads the CLI version from the packaged package.json (next to dist/). */
function readVersion (): string {
  try {
    const package_ = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string }
    return package_.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const program = new Command()

program
  .name('nx-magic')
  .description('Create and fix NX monorepos for Azure DevOps')
  .version(readVersion())

program
  .command('new')
  .argument('[name]', 'monorepo name')
  .option('-y, --yes', 'non-interactive: accept provided values and defaults')
  .option('--scope <scope>', 'npm scope, e.g. @auto')
  .option('--ci <provider>', 'CI provider: azure | github | both')
  .option('--registry <kind>', 'registry: azure-artifacts | github-packages | npm')
  .option('--owner <owner>', 'GitHub owner for the github-packages registry')
  .option('--org <org>', 'Azure DevOps organization')
  .option('--project <project>', 'Azure DevOps project')
  .option('--feed <feed>', 'Azure Artifacts feed')
  .option('--base <branch>', 'default git branch')
  .option('--lib <name>', 'initial internal library name (empty string to skip)')
  .description('Scaffold a brand-new canonical NX monorepo')
  .action(async (name: string | undefined, options: {
    yes?:      boolean
    scope?:    string
    ci?:       string
    registry?: string
    owner?:    string
    org?:      string
    project?:  string
    feed?:     string
    base?:     string
    lib?:      string
  }) => {
    await runNew({
      name,
      yes:          options.yes,
      scope:        options.scope,
      ci:           options.ci as CiProvider | undefined,
      registry:     options.registry as RegistryConfig['kind'] | undefined,
      owner:        options.owner,
      organization: options.org,
      project:      options.project,
      feed:         options.feed,
      base:         options.base,
      lib:          options.lib,
    })
  })

program
  .command('add')
  .argument('[type]', 'function-app | react-app | internal-lib | publishable-lib | cli-tool')
  .argument('[name]', 'project name')
  .description('Add a new project to the current monorepo')
  .action(async (type?: string, name?: string) => {
    await runAdd({ type, name })
  })

program
  .command('doctor')
  .alias('fix')
  .option('--fix', 'apply fixes instead of only reporting')
  .description('Detect and repair configuration drift in the current monorepo')
  .action(async (options: { fix?: boolean }) => {
    await runDoctor({ apply: options.fix ?? false })
  })

program
  .command('update')
  .description('Re-sync tool-owned files to the latest templates and apply migrations')
  .action(async () => {
    await runUpdate()
  })

/** Runs the CLI, reporting uncaught command errors instead of letting them crash the process. */
async function main (): Promise<void> {
  try {
    await program.parseAsync(process.argv)
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

main()
