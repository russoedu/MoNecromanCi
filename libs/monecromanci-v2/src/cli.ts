import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Command } from 'commander'
import { runAdd, type AddOptions, type ProjectKind } from './commands/add'
import { runNew, type NewOptions } from './commands/new'
import { logger } from './util/logger'

/** Reads the CLI version from the packaged package.json (next to dist/). */
function readVersion (): string {
  try {
    const package_ = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string }
    return package_.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Builds the commander program for the v2 CLI.
 *
 * @remarks
 * Two commands only — `new` and `add` — per the box-out scope. Everything a
 * generated repo needs day-to-day (build/test/lint/release) is plain Nx, so
 * the CLI deliberately has no wrapper commands for those.
 *
 * @param None - this function takes no parameters.
 * @returns The configured commander program.
 * @throws Never - wiring only; execution errors surface when commands run.
 * @typeParam None - this function has no generic type parameters.
 */
export function buildProgram (): Command {
  const program = new Command()

  program
    .name('mnci2')
    .description('MoNecromanCI v2 — a thin CLI over official Nx plugins')
    .version(readVersion(), '-v, --version', 'display the version')

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
    .option('--agent <pool>', 'CI build agent: a vmImage (e.g. ubuntu-latest) or self-hosted pool name')
    .option('--variable-group <name>', 'Azure DevOps variable group holding the npm PAT')
    .action(async (name: string | undefined, options: NewOptions) => {
      await runNew(name, options)
    })

  program
    .command('add')
    .argument('[kind]', 'react-app | function-app | npm-lib | internal-lib')
    .argument('[name]', 'project name')
    .description('Add a project by delegating to the matching Nx plugin generator')
    .option('--scope <scope>', 'npm scope for a publishable lib (defaults to @<workspace name>)')
    .action(async (kind: ProjectKind | undefined, name: string | undefined, options: AddOptions) => {
      await runAdd(kind, name, options)
    })

  return program
}

/**
 * CLI entry point: parse arguments and surface failures as exit code 1.
 *
 * @remarks
 * Exported so tests can drive the program without spawning a process.
 *
 * @param None - this function takes no parameters.
 * @returns A promise that resolves when the invoked command completes.
 * @throws Never - failures are logged and turned into a non-zero exit code.
 * @typeParam None - this function has no generic type parameters.
 */
export async function main (): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv)
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

// Only self-execute when run as a binary, not when imported by tests.
if (require.main === module) {
  main()
}
