import { execFileSync } from 'node:child_process'
import { posix } from 'node:path'
import type { ProjectGraph, Tree } from '@nx/devkit'
import type * as NxRelease from 'nx/release'
import { pythonCommand } from '../internal/python-command.algorithm'
import { parseVendorEntries } from '../internal/vendor.algorithm'
import {
  normaliseDistributionName,
  pyprojectDependencies,
  pyprojectName,
  requirementName,
  requirementSpecifier,
  withRewrittenDependency,
} from '../internal/pyproject.algorithm'
// eslint-disable-next-line @typescript-eslint/no-require-imports -- nx/release is CJS; no ESM entry to `import` from.
const { VersionActions } = require('nx/release') as typeof NxRelease

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
   * This project's `pyproject.toml` path, as a Tree path.
   *
   * @returns The workspace-relative, forward-slashed manifest path.
   * @throws Never - pure string build.
   * @typeParam None - this method has no generic type parameters.
   */
  #manifestPath (): string {
    return posix.join(this.projectGraphNode.data.root, 'pyproject.toml')
  }

  /**
   * The distribution name an Nx project publishes.
   *
   * @remarks
   * The indirection is unavoidable: Nx names a dependency by its PROJECT name
   * while a `pyproject.toml` names it by its DISTRIBUTION name, and the two
   * differ in every workspace where a project folder is not spelled exactly
   * like the package it ships.
   *
   * @param tree - The Nx virtual file system.
   * @param projectGraph - Where the dependency's root is found.
   * @param projectName - The Nx project name.
   * @returns The distribution name, or `undefined` when the project has no
   * readable `pyproject.toml`.
   * @throws Never - an unreadable manifest yields `undefined`.
   * @typeParam None - this method has no generic type parameters.
   */
  #distributionOf (
    tree: Tree,
    projectGraph: ProjectGraph,
    projectName: string,
  ): string | undefined {
    const root = projectGraph.nodes[projectName]?.data.root
    if (root === undefined) {
      return undefined
    }
    const content = tree.read(posix.join(root, 'pyproject.toml'), 'utf8')

    return content === null ? undefined : pyprojectName(content)
  }

  /**
   * Reads the current version from `pyproject.toml`'s `[project]` table.
   *
   * @param tree - The Nx virtual file system.
   * @returns The current version and the manifest path, or `null` when the
   * manifest does not exist.
   * @throws Error when the manifest exists but has no `version = "..."` line.
   * @typeParam None - this method has no generic type parameters.
   */
  async readCurrentVersionFromSourceManifest (
    tree: Tree,
  ): Promise<{ currentVersion: string; manifestPath: string } | null> {
    // `posix.join`, never plain `join`. An Nx `Tree` path is always
    // workspace-relative and forward-slashed on EVERY platform, while `join`
    // emits `packages\shared\...` on Windows. That is not cosmetic: the value
    // is returned to `nx release`, which carries it into changelog and manifest
    // bookkeeping, and it is interpolated into the error below. Same class as
    // the `toPosix` bug written up in the CLI's `doctor.ts`.
    //
    // `posix.join` rather than devkit's `joinPathFragments` because that one is
    // a VALUE import from `@nx/devkit`, which pulls Nx's whole plugin runtime
    // into a module that only ever needed a string — enough to break a spec
    // that mocks `node:child_process`, and dead weight on the release path.
    const manifestPath = posix.join(this.projectGraphNode.data.root, 'pyproject.toml')
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
  ): Promise<{ currentVersion: string | null; logText: string } | null> {
    const name = this.projectGraphNode.name
    try {
      const output = execFileSync(pythonCommand(), ['-m', 'pip', 'index', 'versions', name], {
        encoding: 'utf8',
        stdio:    ['ignore', 'pipe', 'ignore'],
      })
      const match = /Available versions:\s*([^\s,]+)/.exec(output)

      return { currentVersion: match ? match[1] : null, logText: 'from pip index versions' }
    } catch {
      return { currentVersion: null, logText: 'package not found on registry' }
    }
  }

  /**
   * Resolves the version this project currently requires of a dependency.
   *
   * @remarks
   * Returning `null` here is not neutral, which is what made the previous
   * no-op harmful rather than merely incomplete: Nx `continue`s past any
   * dependency with no current version, so `updateProjectDependencies` is
   * never even asked about it. A workspace releasing `scanmate-ink@0.24.0`
   * therefore left `scanmate-ink>=0.23.0` sitting inside `scanmate-scan` -
   * the under-bump `documentation/releasing.md` exists to prevent, reborn in
   * Python.
   *
   * The VERSION is returned without its operator. Nx reads this value to
   * detect an npm-style `~`/`^`/`=` prefix and may hand it back as the new
   * version when the dependency is not itself being released; a PEP 508
   * operator round-tripping through that logic would produce nonsense. The
   * operator is preserved where it belongs instead - in
   * {@link withRewrittenDependency}, which reads it from the manifest at
   * write time.
   *
   * A VENDORED dependency still returns `null`, and that branch is correct
   * rather than unfinished: the `build` executor copies the internal lib's
   * module into this project's wheel, so there is no requirement entry and no
   * published version to track. It is a real dependency - the graph plugin
   * reports the edge - with nothing in the manifest to rewrite.
   *
   * @param tree - The Nx virtual file system.
   * @param projectGraph - Used to find the dependency's own manifest, since
   * the argument names an Nx project and the manifest names a distribution.
   * @param dependencyProjectName - The Nx project name of the dependency.
   * @returns The required version and `'dependencies'`, or `null` for both
   * when this project does not reference the dependency through a manifest.
   * @throws Never - anything it cannot read yields `null`.
   * @typeParam None - this method has no generic type parameters.
   */
  async readCurrentVersionOfDependency (
    tree: Tree,
    projectGraph: ProjectGraph,
    dependencyProjectName: string,
  ): Promise<{ currentVersion: string | null; dependencyCollection: string | null }> {
    const content = tree.read(this.#manifestPath(), 'utf8')
    if (content === null) {
      return { currentVersion: null, dependencyCollection: null }
    }
    if (parseVendorEntries(content).includes(dependencyProjectName)) {
      return { currentVersion: null, dependencyCollection: null }
    }
    const distribution = this.#distributionOf(tree, projectGraph, dependencyProjectName)
    if (distribution === undefined) {
      return { currentVersion: null, dependencyCollection: null }
    }
    const wanted = normaliseDistributionName(distribution)
    const entry = pyprojectDependencies(content).find((candidate) => {
      const name = requirementName(candidate)

      return name !== undefined && normaliseDistributionName(name) === wanted
    })
    if (entry === undefined) {
      return { currentVersion: null, dependencyCollection: null }
    }
    // Everything that is not the version itself - the operator, and any extras
    // or environment marker - is dropped, for reporting purposes only.
    const version = /\d[^\s,;]*/.exec(requirementSpecifier(entry))?.[0] ?? null

    return { currentVersion: version, dependencyCollection: 'dependencies' }
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
    const manifestPath = this.#manifestPath()
    const content = tree.read(manifestPath, 'utf8') ?? ''
    tree.write(
      manifestPath,
      content.replace(VERSION_LINE, () => `version = "${newVersion}"`),
    )

    return [`Updated ${manifestPath} to version ${newVersion}`]
  }

  /**
   * Rewrites the versions this project requires of its released dependencies.
   *
   * @remarks
   * This is the Python half of what `nx release` already does to a
   * `package.json` range, and the operator is the part that matters. A
   * manifest declaring `scanmate-ink>=0.23.0` is stating a FLOOR; rewriting it
   * to `scanmate-ink==0.24.0` would change the dependency's meaning while
   * looking like a version bump, so {@link withRewrittenDependency} keeps
   * whichever operator the author wrote.
   *
   * Nx keys the map by Nx PROJECT name and may include an npm-style `~`/`^`
   * prefix on the value, which means nothing in a PEP 508 specifier and is
   * stripped here rather than written into the manifest.
   *
   * A dependency it cannot rewrite is REPORTED, never silently skipped. An
   * unpinned entry, a compound range or a direct URL reference each get a line
   * saying so, because a dependant whose specifier did not move is precisely
   * the stale reference this method exists to prevent - and a release that
   * quietly left one behind would look identical to one that had nothing to do.
   *
   * @param tree - The Nx virtual file system.
   * @param projectGraph - Used to map each Nx project name to the distribution
   * name its manifest declares.
   * @param dependenciesToUpdate - New version per dependency Nx project name.
   * @returns One log line per dependency considered.
   * @throws Never - a manifest it cannot read yields no messages.
   * @typeParam None - this method has no generic type parameters.
   */
  async updateProjectDependencies (
    tree: Tree,
    projectGraph: ProjectGraph,
    dependenciesToUpdate: Record<string, string>,
  ): Promise<string[]> {
    const manifestPath = this.#manifestPath()
    let content = tree.read(manifestPath, 'utf8')
    if (content === null) {
      return []
    }
    const messages: string[] = []
    let changed = false

    for (const [dependencyProjectName, rawVersion] of Object.entries(dependenciesToUpdate)) {
      if (parseVendorEntries(content).includes(dependencyProjectName)) {
        messages.push(
          `Skipped ${dependencyProjectName} in ${manifestPath}: vendored into the wheel, so it carries no requirement to update`,
        )
        continue
      }
      const distribution = this.#distributionOf(tree, projectGraph, dependencyProjectName)
      if (distribution === undefined) {
        continue
      }
      // `~`, `^` and `=` are npm prefixes; PEP 508 has no such notion.
      const newVersion = rawVersion.replace(/^[~^=]/, '')
      const rewritten = withRewrittenDependency(content, distribution, newVersion)
      if (rewritten === undefined) {
        messages.push(
          `Could not update ${distribution} to ${newVersion} in ${manifestPath}: its requirement is unpinned, a compound range, or a direct reference`,
        )
        continue
      }
      content = rewritten.content
      changed = true
      messages.push(`Updated ${manifestPath}: "${rewritten.from}" -> "${rewritten.to}"`)
    }

    if (changed) {
      tree.write(manifestPath, content)
    }

    return messages
  }
}
