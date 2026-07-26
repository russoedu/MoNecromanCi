import { join } from 'node:path'
import type { ProjectGraph, Tree } from '@nx/devkit'
import { readPubspecVersion, writePubspecVersion } from '../internal/pubspec'
// eslint-disable-next-line @typescript-eslint/no-require-imports -- nx/release is CJS; no ESM entry to `import` from.
const { VersionActions } = require('nx/release') as typeof import('nx/release')

/**
 * Hand-written Nx release `VersionActions` for Dart/Flutter packages — reads
 * and writes the top-level `version:` key of `pubspec.yaml`.
 *
 * @remarks
 * This is not an optional nicety. Nx's default `VersionActions` reads a
 * `package.json`, and a Dart package has none, so without a project-level
 * override `nx release` aborts with *"Unable to determine the current version
 * for project X from &lt;root&gt;/package.json"* — and because that error is raised
 * while building the release graph, it takes down the release of **every**
 * project in the workspace, not just the Dart one. Confirmed empirically
 * against a real `nx release --dry-run`.
 *
 * Registered per project by the `library` generator via
 * `release.version.versionActions`, which wins over whatever default the
 * consuming workspace's `nx.json` sets (npm's, typically).
 *
 * @typeParam None - this class has no generic type parameters.
 */
export default class DartVersionActions extends VersionActions {
  validManifestFilenames = ['pubspec.yaml']

  /**
   * Reads the current version from the project's `pubspec.yaml`.
   *
   * @param tree - The Nx virtual file system.
   * @returns The current version and manifest path, or `null` when the
   * manifest does not exist.
   * @throws Error when the pubspec exists but declares no top-level
   * `version:` key.
   * @typeParam None - this method has no generic type parameters.
   */
  async readCurrentVersionFromSourceManifest(
    tree: Tree
  ): Promise<{ currentVersion: string; manifestPath: string } | null> {
    const manifestPath = join(this.projectGraphNode.data.root, 'pubspec.yaml')
    const contents = tree.read(manifestPath, 'utf8')
    if (contents === null) {
      return null
    }
    const currentVersion = readPubspecVersion(contents)
    if (!currentVersion) {
      throw new Error(`Could not find a top-level "version:" key in ${manifestPath}`)
    }
    return { currentVersion, manifestPath }
  }

  /**
   * Resolves the current published version from a registry.
   *
   * @remarks
   * Always `null`: mnci's Dart packages are published **by git tag only**.
   * Azure Artifacts has no pub/Dart feed type, so there is no private
   * registry to query, and these packages are deliberately not pushed to
   * pub.dev. `nx release` falls back to the disk/tag resolvers, which is the
   * intended path — the same shape `go-lib` uses.
   *
   * @param _tree - Unused (no registry to consult).
   * @param _currentVersionResolverMetadata - Unused.
   * @returns `null` for the version, with an explanatory log line.
   * @throws Never - pure no-op.
   * @typeParam None - this method has no generic type parameters.
   */
  async readCurrentVersionFromRegistry(
    _tree: Tree,
    _currentVersionResolverMetadata: Record<string, unknown> | undefined
  ): Promise<{ currentVersion: string | null; logText: string } | null> {
    return {
      currentVersion: null,
      logText: 'Dart packages are released by git tag, not a registry',
    }
  }

  /**
   * Resolves the current version of a dependency of this project.
   *
   * @remarks
   * Nothing to report: workspace members resolve each other locally through
   * the root pub workspace, so a dependency's version is whatever is on disk
   * in this same repo rather than a separately tracked registry reference.
   *
   * @param _tree - Unused.
   * @param _projectGraph - Unused.
   * @param _dependencyProjectName - Unused.
   * @returns `null` for both fields.
   * @throws Never - pure no-op.
   * @typeParam None - this method has no generic type parameters.
   */
  async readCurrentVersionOfDependency(
    _tree: Tree,
    _projectGraph: ProjectGraph,
    _dependencyProjectName: string
  ): Promise<{ currentVersion: string | null; dependencyCollection: string | null }> {
    return { currentVersion: null, dependencyCollection: null }
  }

  /**
   * Writes the newly computed version into `pubspec.yaml`.
   *
   * @param tree - The Nx virtual file system.
   * @param newVersion - The new version to write.
   * @returns A one-line log message describing the change.
   * @throws Never - the manifest was already proven readable by
   * {@link readCurrentVersionFromSourceManifest}.
   * @typeParam None - this method has no generic type parameters.
   */
  async updateProjectVersion(tree: Tree, newVersion: string): Promise<string[]> {
    const manifestPath = join(this.projectGraphNode.data.root, 'pubspec.yaml')
    const contents = tree.read(manifestPath, 'utf8') ?? ''
    tree.write(manifestPath, writePubspecVersion(contents, newVersion))
    return [`Updated ${manifestPath} to version ${newVersion}`]
  }

  /**
   * Updates dependency versions in this project's manifest.
   *
   * @remarks
   * Same reasoning as {@link readCurrentVersionOfDependency}: a workspace
   * member depends on a sibling through a plain version constraint that pub
   * resolves locally, so bumping a sibling does not require rewriting this
   * pubspec.
   *
   * @param _tree - Unused.
   * @param _projectGraph - Unused.
   * @param _dependenciesToUpdate - Unused.
   * @returns An empty array — nothing changed.
   * @throws Never - pure no-op.
   * @typeParam None - this method has no generic type parameters.
   */
  async updateProjectDependencies(
    _tree: Tree,
    _projectGraph: ProjectGraph,
    _dependenciesToUpdate: Record<string, string>
  ): Promise<string[]> {
    return []
  }
}
