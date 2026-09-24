import { join } from 'node:path'
import { promptText } from '../terminal'
import { repairDeclarationSpecifiers, repairPublishableManifest } from '../rollup-library'
import { removeLocalRegistryScaffolding } from '../workspace-overlay'
import {
  defaultScope,
  markPublic,
  registerProjectCommands,
  removeGeneratedEslintConfig,
  runGeneratorAndRepair,
  writeProjectReadme,
  type AddOptions,
  type WorkspaceStack,
} from './post-generation.use-case'

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
 * Routed through {@link runGeneratorAndRepair} rather than calling `runNx`
 * directly: this generator's `@nx/rollup`/vitest plugin install can fail for
 * reasons unrelated to the generator itself (reproduced with a real npm 10
 * arborist bug on this exact dependency tree) after every file below has
 * already been written, and without the wrapper every repair — the `types`
 * fix, the declaration/source-map fixes, `registerProjectCommands` — would
 * silently never run, leaving a broken, half-configured project that
 * `mnci doctor` could not fully catch.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @param options - The CLI flags.
 * @param kindProvided - Whether `kind` was passed as a flag (vs. prompted) —
 * gates whether the scope is prompted for or silently defaulted.
 * @param stack - The workspace's chosen test runner.
 * @returns A promise that resolves when the generator has finished.
 * @throws Error when the generator's own scaffolding step fails, or a
 * clearer wrapped error when the scaffold was written but its install step
 * failed anyway — see {@link runGeneratorAndRepair}.
 * @typeParam None - this function has no generic type parameters.
 */
export async function addNpmLib (
  workspaceRoot: string,
  name: string,
  options: AddOptions,
  kindProvided: boolean,
  stack: WorkspaceStack,
): Promise<void> {
  const scope =
    options.scope ??
    (kindProvided
      ? defaultScope(workspaceRoot)
      : await promptText('npm scope for the published package', defaultScope(workspaceRoot)))
  const projectRoot = join(workspaceRoot, 'packages', name)
  const manifestPath = join(projectRoot, 'package.json')
  runGeneratorAndRepair(
    workspaceRoot,
    [
      'g',
      '@nx/js:lib',
      `packages/${name}`,
      '--publishable',
      `--importPath=${scope}/${name}`,
      '--bundler=rollup',
      `--unitTestRunner=${stack.testRunner}`,
      '--linter=none',
      '--no-interactive',
    ],
    manifestPath,
    () => {
      markPublic(manifestPath)
      // @nx/js:lib --bundler=rollup writes types: './dist/index.esm.d.ts', a file its
      // own build never emits, so every TypeScript consumer of the published package
      // would get `any`. See repairPublishableManifest.
      repairPublishableManifest(manifestPath)
      // The build writes dist/index.d.ts as a stub whose specifier @nx/rollup builds
      // with path.relative(), so on Windows it is not a valid module specifier at all.
      repairDeclarationSpecifiers(projectRoot)
      // The @nx/dependency-checks exclusions this kind needs now live in the ROOT
      // config (@mnci/eslint-config's dependencyChecks block), so the generator's
      // per-project config is deleted rather than overwritten.
      // Nx writes a README crediting itself; mnci generated this project.
      writeProjectReadme(projectRoot, `${scope}/${name}`, stack.testRunner)
      removeGeneratedEslintConfig(workspaceRoot, `packages/${name}`)
      // `--publishable` also scaffolds a whole local-registry story (verdaccio
      // config, devDependency, root target) that mnci's tag-only release model
      // has no use for.
      removeLocalRegistryScaffolding(workspaceRoot)
      registerProjectCommands(workspaceRoot, name, { build: true })
    },
  )
}
