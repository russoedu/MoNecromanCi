import { Argument, Command } from 'commander'
import { PROJECT_KINDS, runAdd, type AddOptions, type ProjectKind } from './commands/add'
import { runInteractive } from './commands/interactive'
import { runNew, type NewOptions } from './commands/new'
import { runUpgrade, type UpgradeOptions } from './commands/upgrade'
import { logger } from './util/logger'
import { checkForUpdate, readCliVersion } from './util/versionChecker'

/**
 * Builds the commander program for the CLI.
 *
 * @remarks
 * Three commands: `new`, `add`, and `upgrade` (re-applies the overlay to an
 * existing workspace — see `commands/upgrade.ts`). Everything a generated
 * repo needs day-to-day (build/test/lint/release) is plain Nx, so the CLI
 * deliberately has no wrapper commands for those.
 *
 * @param cliVersion - The current CLI version (from package.json).
 * @returns The configured commander program.
 * @throws Never - wiring only; execution errors surface when commands run.
 * @typeParam None - this function has no generic type parameters.
 */
export function buildProgram(cliVersion: string): Command {
  const program = new Command()

  program
    .name('mnci')
    .description('MoNecromanCI — a thin CLI over official Nx plugins')
    .version(cliVersion, '-v, --version', 'display the version')

  program
    .command('new')
    .argument('[name]', 'workspace name')
    .description('Create a new monorepo (Nx TS preset + release/pipeline overlay)')
    .option('-y, --yes', 'accept defaults for anything not passed as a flag')
    .option('--scope <scope>', 'npm scope for publishable packages (e.g. @demo)')
    .option('--registry <kind>', 'azure-artifacts | npm')
    .option('--organization <name>', 'Azure DevOps organization')
    .option('--project <name>', 'Azure DevOps project')
    .option('--artifacts-feed <name>', 'Azure Artifacts feed')
    .option(
      '--agent <pool>',
      'CI build agent: a vmImage (e.g. ubuntu-latest) or self-hosted pool name'
    )
    .option('--variable-group <name>', 'Azure DevOps variable group holding the npm PAT')
    .option('--ci <provider>', 'CI provider: azure | github | both')
    .option('--test-runner <runner>', 'unit-test runner: jest | vitest')
    .option('--nx-cloud', 'connect the workspace to Nx Cloud (remote caching + CI insights)')
    .action(async (name: string | undefined, options: NewOptions) => {
      await runNew(name, options)
    })

  program
    .command('upgrade')
    .description(
      'Re-apply the latest MoNecromanCI overlay to this workspace (release config, pipeline, npmrc, commitlint, husky hook, curated scripts)'
    )
    .option('--scope <scope>', 'npm scope for publishable packages (overrides the persisted value)')
    .option('--registry <kind>', 'azure-artifacts | npm (overrides the persisted value)')
    .option('--organization <name>', 'Azure DevOps organization')
    .option('--project <name>', 'Azure DevOps project')
    .option('--artifacts-feed <name>', 'Azure Artifacts feed')
    .option('--agent <pool>', 'CI build agent (overrides the persisted value)')
    .option('--variable-group <name>', 'Azure DevOps variable group holding the npm PAT')
    .option('--ci <provider>', 'CI provider: azure | github | both (overrides the persisted value)')
    .option(
      '--test-runner <runner>',
      'unit-test runner: jest | vitest (overrides the persisted value)'
    )
    .action((options: UpgradeOptions) => {
      runUpgrade(process.cwd(), options)
    })

  program
    .command('add')
    // choices() rejects an unrecognized kind with a clean commander usage
    // error (and lists the valid ones in --help) before runAdd ever runs —
    // instead of a typo silently doing nothing but reporting "success".
    .addArgument(new Argument('[kind]', 'project kind').choices(PROJECT_KINDS))
    .argument('[name]', 'project name')
    .description('Add a project by delegating to the matching Nx plugin generator')
    .option('--scope <scope>', 'npm scope for a publishable lib (defaults to @<workspace name>)')
    .option(
      '--framework <framework>',
      'node-app only: express | fastify | koa | nest | none (default: none)'
    )
    .option(
      '--lib <name>',
      'python-vendor only: the internal Python library (libs/<name>) to vendor into <name>'
    )
    .action(
      async (kind: ProjectKind | undefined, name: string | undefined, options: AddOptions) => {
        await runAdd(kind, name, options)
      }
    )

  // Bare `mnci` (no subcommand) launches the guided wizard; commander runs
  // this default action only when no subcommand is given (-v/--help still win).
  program.action(async () => {
    await runInteractive()
  })

  return program
}

/**
 * CLI entry point: parse arguments and surface failures as exit code 1.
 *
 * @remarks
 * Exported so tests can drive the program without spawning a process.
 * Runs a non-blocking version check in the background (fire-and-forget).
 *
 * @param None - this function takes no parameters.
 * @returns A promise that resolves when the invoked command completes.
 * @throws Never - failures are logged and turned into a non-zero exit code.
 * @typeParam None - this function has no generic type parameters.
 */
export async function main(): Promise<void> {
  try {
    const cliVersion = readCliVersion(__dirname)
    const program = buildProgram(cliVersion)

    // Check for updates in the background (non-blocking).
    checkForUpdate(cliVersion)

    await program.parseAsync(process.argv)
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

// Only self-execute when run as a binary, not when imported by tests.
if (require.main === module) {
  main()
}
