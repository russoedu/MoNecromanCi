import { runNx, runShell } from '../../nx'
import { logger } from '../../util/logger'
import { ensureAdmZip, hasPlugin } from './shared'

/**
 * Fails fast, with an install hint, when the Flutter SDK is not on the PATH.
 *
 * @remarks
 * Mirrors `ensureGo` in `add/go.ts` and `ensurePython` in `add/python.ts`:
 * probed before any install or generator call, so a missing toolchain
 * surfaces as one clear sentence rather than an opaque generator crash
 * halfway through scaffolding.
 *
 * This probe matters more here than for the other stacks: Python and Go both
 * ship on every hosted CI image, whereas Flutter does not — it is the one
 * toolchain the generated pipeline has to install itself.
 *
 * @param workspaceRoot - Absolute path to the workspace (cwd for the probe).
 * @returns Nothing.
 * @throws Error when `flutter` cannot be run.
 * @typeParam None - this function has no generic type parameters.
 */
function ensureFlutter(workspaceRoot: string): void {
  if (runShell('flutter', ['--version'], workspaceRoot) !== 0) {
    throw new Error(
      'Flutter not found. Install the Flutter SDK first (3.27+, for Dart 3.6+ pub workspaces): https://docs.flutter.dev/get-started/install'
    )
  }
}

/**
 * The `@mnci/nx-flutter` package spec to install.
 *
 * @remarks
 * Reads `MNCI_NX_FLUTTER_SPEC` so the e2e suite can point this at a local
 * tarball (`npm pack`'d from `packages/nx-flutter` in this same monorepo)
 * instead of the published registry package — the published spec is the
 * default for every real `mnci add flutter-*` call. Same escape hatch
 * `add/python.ts` uses via `MNCI2_PYTHON_PIP_SPEC`.
 *
 * @returns The npm spec to install.
 * @throws Never - reads an environment variable.
 * @typeParam None - this function has no generic type parameters.
 */
function nxFlutterPluginSpec(): string {
  return process.env.MNCI_NX_FLUTTER_SPEC ?? '@mnci/nx-flutter'
}

/**
 * Ensures the `@mnci/nx-flutter` Nx plugin is installed.
 *
 * @remarks
 * Like `@mnci/nx-python-pip`, this plugin needs no `nx.json` `plugins`
 * registration: its generators and executors are explicit, resolved by plain
 * Node module lookup against its `generators.json`/`executors.json`.
 * Registration in `plugins` is only for inference plugins that scan the
 * filesystem, which this is not.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Error when the install exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function ensureNxFlutterPlugin(workspaceRoot: string): void {
  if (hasPlugin(workspaceRoot, '@mnci/nx-flutter')) {
    return
  }
  const spec = nxFlutterPluginSpec()
  logger.step(`Installing the Flutter toolchain plugin (${spec})`)
  if (
    runShell('npm', ['install', '--save-dev', spec, '--no-audit', '--no-fund'], workspaceRoot) !== 0
  ) {
    throw new Error('npm install of @mnci/nx-flutter failed')
  }
}

/** Shared preflight for every Flutter kind: toolchain, then plugin. */
function prepareFlutter(workspaceRoot: string): void {
  ensureFlutter(workspaceRoot)
  ensureNxFlutterPlugin(workspaceRoot)
}

/**
 * Adds a Flutter web application under `apps/`.
 *
 * @remarks
 * Pure delegation to `@mnci/nx-flutter:application`, which scaffolds the app
 * via the official `flutter create`, registers it as a member of the root pub
 * workspace, and writes the lint/test/build/package targets. `adm-zip` is
 * installed here rather than by the plugin because the `package` (zip
 * into `dist/drop/`) convention is mnci's own CI contract, not something a
 * generic Nx plugin should assume.
 *
 * Web is the only platform scaffolded — see the plugin's `application`
 * generator for why (an Android build would drag the whole Android SDK onto
 * every build agent).
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Flutter is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addFlutterApp(workspaceRoot: string, name: string): void {
  prepareFlutter(workspaceRoot)
  ensureAdmZip(workspaceRoot)
  runNx(['g', '@mnci/nx-flutter:application', name, '--no-interactive'], workspaceRoot)
}

/**
 * Adds a publishable Flutter/Dart package under `packages/`.
 *
 * @remarks
 * "Publishable" means the same thing as it does for `go-lib`: there is **no
 * registry upload**. Azure Artifacts has no pub/Dart feed type, so publishing
 * is the git tag `nx release` creates and consumers depend on that tag.
 *
 * The plugin's generator stamps a project-level `versionActions` override so
 * `nx release` versions `pubspec.yaml`. That is not cosmetic: without it Nx
 * looks for a `package.json` a Dart package does not have and fails the
 * release for the *entire* workspace.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Flutter is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addFlutterLib(workspaceRoot: string, name: string): void {
  prepareFlutter(workspaceRoot)
  runNx(['g', '@mnci/nx-flutter:library', name, '--no-interactive'], workspaceRoot)
}

/**
 * Adds a private Flutter/Dart package under `libs/`.
 *
 * @remarks
 * Never released — `libs/` sits outside `release.projects`. Consumers depend
 * on it with a **plain version constraint and no `path:`**: being a member of
 * the root pub workspace is what makes pub resolve it locally. That is the
 * whole point of the pub-workspace model, and it means Flutter needs no
 * vendoring step at all (contrast `mnci add python-vendor`, which exists only
 * because pip cannot bundle an unpublished sibling into a wheel).
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Flutter is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addFlutterInternalLib(workspaceRoot: string, name: string): void {
  prepareFlutter(workspaceRoot)
  runNx(['g', '@mnci/nx-flutter:internal-library', name, '--no-interactive'], workspaceRoot)
}
