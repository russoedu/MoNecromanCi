import { join } from 'node:path'
import { runNx } from '../../nx'
import { promptText } from '../../prompts'
import { readJson, toJson, writeFileEnsured } from '../../util/fsx'
import {
  defaultScope,
  ensurePlugin,
  markPrivate,
  markPublic,
  registerProjectCommands,
  removeGeneratedEslintConfig,
  type AddOptions,
  type WorkspaceStack
} from './shared'

/**
 * The declaration path `@nx/react:library --bundler=rollup` writes, which its own
 * build never produces.
 */
const WRONG_TYPES_PATH = './dist/index.esm.d.ts'

/** The declaration path that rollup build actually emits. */
const ACTUAL_TYPES_PATH = './dist/index.d.ts'

/**
 * Repoints a generated React library's `types` entries at the declaration file
 * its build actually emits.
 *
 * @remarks
 * Works around a real inconsistency in `@nx/react:library --bundler=rollup`, not
 * a preference: the generator writes `types: './dist/index.esm.d.ts'` (and the
 * same path under `exports['.']`), while its rollup build emits
 * `dist/index.d.ts`. The referenced file therefore never exists, and any
 * consumer importing the library fails with
 * `TS7016: Could not find a declaration file for module '@scope/name'` — so a
 * publishable React lib could not be consumed as a typed dependency at all.
 *
 * Verified empirically against a real generated pair: a `react-lib` importing a
 * `react-internal-lib` fails `typecheck` before this repair and passes after,
 * with `dist/index.d.ts` confirmed present in the build output. `main`/`module`
 * are left alone — they correctly point at `index.esm.js`, which *is* emitted;
 * only the declaration paths are wrong.
 *
 * The same class of bug as the `node-function-app` manifest `main` fix: a
 * generator-written path that is right for a layout other than the one actually
 * produced. Guarded on the exact wrong value, so if Nx corrects this upstream the
 * repair quietly stops applying instead of overwriting a now-correct path.
 *
 * @param manifestPath - Absolute path to the library's `package.json`.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
function repairTypesPath (manifestPath: string): void {
  const manifest = readJson<{
    types?: string
    exports?: Record<string, string | { types?: string }>
  }>(manifestPath)

  if (manifest.types === WRONG_TYPES_PATH) {
    manifest.types = ACTUAL_TYPES_PATH
  }
  const dot = manifest.exports?.['.']
  if (typeof dot === 'object' && dot.types === WRONG_TYPES_PATH) {
    dot.types = ACTUAL_TYPES_PATH
  }
  writeFileEnsured(manifestPath, toJson(manifest))
}

/**
 * The bundler both React library kinds are generated with.
 *
 * @remarks
 * `@nx/react:library` defaults to `none`, and that default is wrong for both
 * kinds here, for two different reasons:
 *
 * - For a **publishable** lib, a bundler is what lets a published package depend
 *   on a private internal lib at all: `@nx/rollup`'s `withNx` externalizes
 *   exactly the manifest's `dependencies`/`peerDependencies`, so an imported
 *   internal lib (never declared, since npm workspaces links it regardless) is
 *   compiled INTO the bundle and its private name never reaches the published
 *   `package.json`. Same reasoning as `npm-lib`.
 * - For an **internal** lib, it has to be *buildable*: the default
 *   `@nx/enforce-module-boundaries` rule forbids a buildable library (every
 *   publishable lib) from importing a non-buildable one, so a non-buildable
 *   React lib could not be consumed by a `react-lib` or `npm-lib` at all.
 *
 * `rollup` rather than `vite` because these are libraries, not apps — and it
 * keeps both React kinds on the same bundler as `npm-lib`, so there is one
 * externalization story to reason about rather than two. Note `tsc` is not an
 * option here: unlike `@nx/js:lib`, this generator's enum is
 * `none | vite | rollup` (verified against the real 23.1.0 schema).
 */
const REACT_LIB_BUNDLER = 'rollup'

/**
 * Adds a publishable React component library under `packages/`.
 *
 * @remarks
 * The React counterpart of `npm-lib`, and the kind that was missing entirely —
 * before this, a shared component library could not be built at all, because
 * `npm-lib` and `internal-lib` both use `@nx/js:lib`, which has no JSX support.
 *
 * Pure delegation to the official `@nx/react:library`, plus the same two
 * post-generation touches `npm-lib` needs: {@link markPublic} (npm treats every
 * scoped package as private, so a first publish 402s without it) and deleting the
 * per-project ESLint config the generator writes.
 *
 * The scope is resolved the same way `npm-lib` resolves it: an explicit
 * `--scope` wins; otherwise the flag path defaults it silently while the
 * interactive path prompts, with the workspace's own scope as the default.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @param options - The CLI flags.
 * @param kindProvided - Whether `kind` was passed as a flag (vs. prompted) —
 * gates whether the scope is prompted for or silently defaulted.
 * @param stack - The workspace's chosen test runner.
 * @returns A promise that resolves when the generator has finished.
 * @throws Error when the generator or the plugin install exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
export async function addReactLib (
  workspaceRoot: string,
  name: string,
  options: AddOptions,
  kindProvided: boolean,
  stack: WorkspaceStack
): Promise<void> {
  ensurePlugin(workspaceRoot, '@nx/react')
  const scope =
    options.scope ??
    (kindProvided
      ? defaultScope(workspaceRoot)
      : await promptText('npm scope for the published package', defaultScope(workspaceRoot)))
  runNx(
    [
      'g',
      '@nx/react:library',
      `packages/${name}`,
      `--name=${name}`,
      '--publishable',
      `--importPath=${scope}/${name}`,
      `--bundler=${REACT_LIB_BUNDLER}`,
      `--unitTestRunner=${stack.testRunner}`,
      '--linter=none',
      '--no-interactive'
    ],
    workspaceRoot
  )
  const publishableManifest = join(workspaceRoot, 'packages', name, 'package.json')
  markPublic(publishableManifest)
  repairTypesPath(publishableManifest)
  removeGeneratedEslintConfig(workspaceRoot, `packages/${name}`)
  registerProjectCommands(workspaceRoot, name, { build: true })
}

/**
 * Adds a private React component library under `libs/`.
 *
 * @remarks
 * Same generator as {@link addReactLib} minus the publishable intent: it lands in
 * `libs/` (never released — the directory *is* the release scoping) and is marked
 * `private` so it is structurally unpublishable no matter what config drifts
 * later. This is the common case for a shared component library consumed by apps
 * in the same monorepo.
 *
 * Still built with {@link REACT_LIB_BUNDLER} rather than left non-buildable —
 * see that constant for why `enforce-module-boundaries` makes that load-bearing.
 *
 * No `start` command: a library has no dev-server story, so
 * {@link registerProjectCommands} gets `build` and the unconditional `qa` only.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @param stack - The workspace's chosen test runner.
 * @returns Nothing.
 * @throws Error when the generator or the plugin install exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
export function addReactInternalLib (
  workspaceRoot: string,
  name: string,
  stack: WorkspaceStack
): void {
  ensurePlugin(workspaceRoot, '@nx/react')
  runNx(
    [
      'g',
      '@nx/react:library',
      `libs/${name}`,
      `--name=${name}`,
      `--bundler=${REACT_LIB_BUNDLER}`,
      `--unitTestRunner=${stack.testRunner}`,
      '--linter=none',
      '--no-interactive'
    ],
    workspaceRoot
  )
  const privateManifest = join(workspaceRoot, 'libs', name, 'package.json')
  markPrivate(privateManifest)
  repairTypesPath(privateManifest)
  removeGeneratedEslintConfig(workspaceRoot, `libs/${name}`)
  registerProjectCommands(workspaceRoot, name, { build: true })
}
