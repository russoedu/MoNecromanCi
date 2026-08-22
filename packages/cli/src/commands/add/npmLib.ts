import { join } from 'node:path'
import { runNx } from '../../nx'
import { promptText } from '../../prompts'
import {
  defaultScope,
  markPublic,
  registerProjectCommands,
  removeGeneratedEslintConfig,
  type AddOptions,
  type WorkspaceStack
} from './shared'

/**
 * Adds a publishable npm library: `@nx/js:lib` as a rollup bundle.
 *
 * @remarks
 * rollup (not tsc): a bundler is what lets a published package depend on
 * private internal libs. `@nx/rollup`'s `withNx` externalizes exactly the
 * manifest's `dependencies`/`peerDependencies` — so imported internal libs
 * (never declared in the manifest, npm workspaces links them regardless) are
 * compiled INTO the bundle from source, and the private name never reaches
 * the published `package.json`.
 *
 * The scope is resolved here: an explicit `--scope` wins; otherwise the flag
 * path (`kindProvided`) defaults it silently, while the interactive/bare path
 * prompts for it (with the workspace's own scope as the default).
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @param options - The CLI flags.
 * @param kindProvided - Whether `kind` was passed as a flag (vs. prompted) —
 * gates whether the scope is prompted for or silently defaulted.
 * @param stack - The workspace's chosen test runner.
 * @returns A promise that resolves when the generator has finished.
 * @throws Error when the generator exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
export async function addNpmLib (
  workspaceRoot: string,
  name: string,
  options: AddOptions,
  kindProvided: boolean,
  stack: WorkspaceStack
): Promise<void> {
  const scope =
    options.scope ??
    (kindProvided
      ? defaultScope(workspaceRoot)
      : await promptText('npm scope for the published package', defaultScope(workspaceRoot)))
  runNx(
    [
      'g',
      '@nx/js:lib',
      `packages/${name}`,
      '--publishable',
      `--importPath=${scope}/${name}`,
      '--bundler=rollup',
      `--unitTestRunner=${stack.testRunner}`,
      '--linter=none',
      '--no-interactive'
    ],
    workspaceRoot
  )
  markPublic(join(workspaceRoot, 'packages', name, 'package.json'))
  // The @nx/dependency-checks exclusions this kind needs now live in the ROOT
  // config (@mnci/eslint-config's dependencyChecks block), so the generator's
  // per-project config is deleted rather than overwritten.
  removeGeneratedEslintConfig(workspaceRoot, `packages/${name}`)
  registerProjectCommands(workspaceRoot, name, { build: true })
}
