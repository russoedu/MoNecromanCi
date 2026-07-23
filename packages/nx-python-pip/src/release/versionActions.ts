import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { ProjectGraph, Tree } from '@nx/devkit'
import { pythonCommand } from '../internal/pythonCommand'
// eslint-disable-next-line @typescript-eslint/no-require-imports -- nx/release is CJS; no ESM entry to `import` from.
const { VersionActions } = require('nx/release') as typeof import('nx/release')

const VERSION_LINE = /^version\s*=\s*"([^"]+)"/m

/**
 * Hand-written Nx release `VersionActions` for pip-native Python packages
 * (no uv, no Poetry) — reads/writes the `version = "..."` line under
 * `pyproject.toml`'s `[project]` table.
 *
 * @remarks
 * Registered per-project via `library` generator's
 * `release.version.versionActions: '@mnci/nx-python-pip/release/version-actions'`
 * (see `generateProject.ts`), which wins over whatever default the
 * consuming workspace's `nx.json` configures. Verified empirically against a
 * real `nx release version --dry-run` (both the disk-fallback and
 * git-tag-based resolution paths).
 *
 * The `version = "..."` line is read/written with a regex, not a TOML
 * library: this package authors `pyproject.toml`'s exact shape itself (via
 * `pythonPyprojectToml`), so a regex on the one line that changes is safe
 * and avoids a TOML dependency for it.
 *
 * @typeParam None - this class has no generic type parameters.
 */
export default class PythonVersionActions extends VersionActions {
  validManifestFilenames = ['pyproject.toml']

  /**
   * Reads the current version from `pyproject.toml`'s `[project]` table.
   *
   * @param tree - The Nx virtual file system.
   * @returns The current version and the manifest path, or `null` when the
   * manifest does not exist.
   * @throws Error when the manifest exists but has no `version = "..."` line.
   * @typeParam None - this method has no generic type parameters.
   */
  async readCurrentVersionFromSourceManifest (tree: Tree): Promise<{ currentVersion: string, manifestPath: string } | null> {
    const manifestPath = join(this.projectGraphNode.data.root, 'pyproject.toml')
    const content = tree.read(manifestPath, 'utf8')
    if (content === null) {
      return null
    }
    const match = VERSION_LINE.exec(content)
    if (!match) {
      throw new Error(`Could not find a "version = ..." line under [project] in ${manifestPath}`)
    }
    return { currentVersion: match[1], manifestPath }
  }

  /**
   * Resolves the current published version via `pip index versions`.
   *
   * @remarks
   * `pip index` is an experimental pip command (stable enough for this
   * lookup); a package that has never been published, or a registry with no
   * matching entry, is not an error here — it just means there is no
   * registry-known current version yet, so `null` is returned instead of
   * throwing (mirrors how a brand-new npm package behaves under the
   * `registry` current-version resolver).
   *
   * @param _tree - Unused (the registry, not the workspace, is the source here).
   * @param _currentVersionResolverMetadata - Unused (no registry-specific metadata needed).
   * @returns The current published version (or `null`) and a log message.
   * @throws Never - a lookup failure yields `null`, not a throw.
   * @typeParam None - this method has no generic type parameters.
   */
  async readCurrentVersionFromRegistry (
    _tree: Tree,
    _currentVersionResolverMetadata: Record<string, unknown> | undefined,
  ): Promise<{ currentVersion: string | null, logText: string } | null> {
    const name = this.projectGraphNode.name
    try {
      const output = execFileSync(pythonCommand(), ['-m', 'pip', 'index', 'versions', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const match = /Available versions:\s*([^\s,]+)/.exec(output)
      return { currentVersion: match ? match[1] : null, logText: 'from pip index versions' }
    } catch {
      return { currentVersion: null, logText: 'package not found on registry' }
    }
  }

  /**
   * Resolves the current version of a dependency of this project.
   *
   * @remarks
   * Internal-lib dependencies are vendored (copied into the wheel at build
   * time by the `build` executor), not registry-referenced, so there is no
   * separate version to track — the same branch `@nxlv/python`'s own
   * reference implementation took for bundled dependencies.
   *
   * @param _tree - Unused.
   * @param _projectGraph - Unused.
   * @param _dependencyProjectName - Unused.
   * @returns `null` for both fields — nothing to report.
   * @throws Never - pure no-op.
   * @typeParam None - this method has no generic type parameters.
   */
  async readCurrentVersionOfDependency (
    _tree: Tree,
    _projectGraph: ProjectGraph,
    _dependencyProjectName: string,
  ): Promise<{ currentVersion: string | null, dependencyCollection: string | null }> {
    return { currentVersion: null, dependencyCollection: null }
  }

  /**
   * Writes the newly computed version into `pyproject.toml`.
   *
   * @param tree - The Nx virtual file system.
   * @param newVersion - The new version to write.
   * @returns A one-line log message describing the change.
   * @throws Never - propagates only if the manifest genuinely cannot be read
   * (would already have thrown in `readCurrentVersionFromSourceManifest`).
   * @typeParam None - this method has no generic type parameters.
   */
  async updateProjectVersion (tree: Tree, newVersion: string): Promise<string[]> {
    const manifestPath = join(this.projectGraphNode.data.root, 'pyproject.toml')
    const content = tree.read(manifestPath, 'utf8') ?? ''
    tree.write(manifestPath, content.replace(VERSION_LINE, () => `version = "${newVersion}"`))
    return [`Updated ${manifestPath} to version ${newVersion}`]
  }

  /**
   * Updates dependency versions in this project's manifest.
   *
   * @remarks
   * Same reasoning as {@link readCurrentVersionOfDependency}: dependencies
   * are vendored, not registry references, so there is nothing to update.
   *
   * @param _tree - Unused.
   * @param _projectGraph - Unused.
   * @param _dependenciesToUpdate - Unused.
   * @returns An empty array — no log messages, nothing changed.
   * @throws Never - pure no-op.
   * @typeParam None - this method has no generic type parameters.
   */
  async updateProjectDependencies (
    _tree: Tree,
    _projectGraph: ProjectGraph,
    _dependenciesToUpdate: Record<string, string>,
  ): Promise<string[]> {
    return []
  }
}
