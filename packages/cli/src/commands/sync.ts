import { join } from 'node:path'
import {
  ECOSYSTEMS,
  PEER_SECTION,
  ROOT_LABEL,
  collectInventory,
  hasEcosystem,
  isWorkspaceProject,
  resolvedVersion,
  rewriteSpec,
  type DependencySite,
  type Ecosystem
} from '../deps/inventory'
import { highestSpec, rangeOperator, specVersion } from '../deps/semver'
import { runFormatter, runShell } from '../nx'
import { fileExists } from '../util/fsx'
import { logger } from '../util/logger'

/**
 * Options accepted by `mnci sync`.
 *
 * @remarks
 * Mirrors `nx sync` / `nx sync:check`: the bare command writes, `--check`
 * reports and fails. A CI step wants the second, a developer the first.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface SyncOptions {
  /** Report drift and exit non-zero without writing anything. */
  check?: boolean
  /** Restrict the run to one ecosystem. */
  ecosystem?: string
}

/**
 * One package declared at two or more incompatible versions.
 *
 * @remarks
 * `fixable` and `blocked` are separate lists rather than one list with a flag
 * because they need different endings: the first is rewritten, the second is
 * reported as a warning naming the spec that could not be understood. Collapsing
 * them is how a `git:` dependency quietly gets a version number written over it.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface Drift {
  /** The package name. */
  name: string
  /** Which ecosystem it belongs to. */
  ecosystem: Ecosystem
  /** The spec every site should converge on. */
  target: string
  /** Why that spec won, for the report. */
  reason: 'resolved' | 'highest'
  /** The sites that disagree with `target` and can be rewritten. */
  fixable: DependencySite[]
  /** Sites that disagree but whose spec shape cannot safely be edited. */
  blocked: DependencySite[]
}

/**
 * Resolves the `--ecosystem` flag to the list of ecosystems to process.
 *
 * @remarks
 * Throws on an unknown value rather than silently processing nothing: a typo in
 * `--ecosystem` would otherwise produce a confident "everything agrees" over a
 * workspace that was never inspected.
 *
 * Shared with `mnci up` so the two commands cannot drift on what they accept.
 *
 * @param requested - The raw flag value, if any.
 * @returns The ecosystems to process.
 * @throws Error when the flag names something that is not an ecosystem.
 * @typeParam None - this function has no generic type parameters.
 */
export function resolveEcosystems (requested: string | undefined): readonly Ecosystem[] {
  if (!requested) {
    return ECOSYSTEMS
  }
  const match = ECOSYSTEMS.find(ecosystem => ecosystem === requested)
  if (!match) {
    throw new Error(
      `Unknown ecosystem '${requested}'. Expected one of: ${ECOSYSTEMS.join(', ')}.`
    )
  }
  return [match]
}

/**
 * Finds every package declared at more than one version across the workspace.
 *
 * @remarks
 * The npm ecosystem has no `catalog:` — pnpm's one-version-per-workspace
 * mechanism — so keeping two projects on the same range is a convention nothing
 * enforces. This is the enforcement, and it deliberately extends to pip and pub
 * for the same reason.
 *
 * **Go is absent by construction, not by omission.** mnci's Go layout is a
 * single root `go.mod`, so one module cannot hold two versions of a dependency;
 * `runSync` says so explicitly rather than letting a silent zero-findings run
 * read as "checked and fine".
 *
 * **Peer ranges are excluded outright, not reported as blocked.** A peer range
 * says which versions a published package is compatible with, so two packages
 * declaring different ones are not in conflict — they are making different,
 * equally valid statements. Reporting them would be noise, and converging them
 * would narrow a published package's supported range. This exclusion exists
 * because the first run of this command against mnci's own repo reported six
 * findings, five of which were peers.
 *
 * The winning spec is the one matching what is actually **resolved** —
 * `node_modules` for npm, `pubspec.lock` for pub, the interpreter for pip.
 * That is the same source `@nx/dependency-checks` pins a drifted range to when
 * it auto-fixes, so this command and that lint rule converge on one answer
 * instead of overwriting each other. When nothing is installed, the highest
 * declared range wins instead — a fallback, and the report says which was used.
 *
 * Read-only: it never touches the workspace, so `runSync` can offer `--check`
 * by simply declining to call {@link applyDrift}.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param ecosystems - Which ecosystems to inspect.
 * @returns Every package whose declarations disagree.
 * @throws Never - unreadable manifests are skipped by the inventory.
 * @typeParam None - this function has no generic type parameters.
 */
export function collectDrift (
  workspaceRoot: string,
  ecosystems: readonly Ecosystem[] = ECOSYSTEMS
): Drift[] {
  // Go has one manifest, so it can never disagree with itself.
  const reconcilable = ecosystems.filter(ecosystem => ecosystem !== 'go')
  const inventory = collectInventory(workspaceRoot, reconcilable)
  const drift: Drift[] = []

  for (const [name, allSites] of inventory) {
    const sites = allSites.filter(site => site.section !== PEER_SECTION)
    // A workspace-internal package is linked, not resolved from a registry;
    // its version is owned by `nx release`, not by this command.
    if (sites.length < 2 || isWorkspaceLocal(workspaceRoot, sites, name)) {
      continue
    }
    const distinct = new Set(sites.map(site => site.spec))
    if (distinct.size < 2) {
      continue
    }

    const installed = resolvedVersion(workspaceRoot, sites[0].ecosystem, name)
    const target = chooseTarget(sites, installed)
    if (!target) {
      continue
    }

    const disagreeing = sites.filter(site => site.spec !== target)
    drift.push({
      name,
      ecosystem: sites[0].ecosystem,
      target,
      reason: installed ? 'resolved' : 'highest',
      fixable: disagreeing.filter(site => site.rewritable),
      blocked: disagreeing.filter(site => !site.rewritable)
    })
  }

  return drift.toSorted((left, right) => left.name.localeCompare(right.name))
}

/**
 * Whether a package is one of this workspace's own projects.
 *
 * @remarks
 * A thin, ecosystem-guarded reading of `isWorkspaceProject`: only npm declares
 * an internal library by a name that maps to a directory, so pip and pub short-
 * circuit rather than testing a path that could accidentally match.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param sites - The declarations for one package name.
 * @param name - The package name.
 * @returns `true` when the package is a project in this workspace.
 * @throws Never - only reads the filesystem.
 * @typeParam None - this function has no generic type parameters.
 */
function isWorkspaceLocal (
  workspaceRoot: string,
  sites: readonly DependencySite[],
  name: string
): boolean {
  // pip internal libs are vendored and pub ones are workspace members, so
  // neither is declared under a name this check could resolve.
  return sites[0].ecosystem === 'npm' && isWorkspaceProject(workspaceRoot, name)
}

/**
 * Picks the spec every site should converge on.
 *
 * @remarks
 * When something is installed, the target keeps the range operator the majority
 * of sites already use rather than imposing a caret — a workspace that pins
 * exactly stays pinned. Ties go to the caret, which is what every Nx generator
 * writes.
 *
 * @param sites - Every declaration of one package.
 * @param installed - The resolved version, when one exists.
 * @returns The spec to converge on, or `undefined` when none can be derived.
 * @throws Never - unparseable specs yield `undefined`.
 * @typeParam None - this function has no generic type parameters.
 */
function chooseTarget (
  sites: readonly DependencySite[],
  installed: string | undefined
): string | undefined {
  if (!installed) {
    return highestSpec(sites.map(site => site.spec))
  }

  const counts = new Map<string, number>()
  for (const site of sites) {
    if (!specVersion(site.spec)) {
      continue
    }
    const operator = rangeOperator(site.spec)
    counts.set(operator, (counts.get(operator) ?? 0) + 1)
  }
  if (counts.size === 0) {
    return undefined
  }

  const [operator] = [...counts].toSorted(
    (left, right) => right[1] - left[1] || (left[0] === '^' ? -1 : 1)
  )[0]
  return `${operator}${installed}`
}

/**
 * Writes every fixable drift back to its manifest.
 *
 * @remarks
 * Deduplicates by manifest path, because one file commonly holds several of the
 * packages being converged and the caller reports what it changed.
 *
 * @param drift - The findings to apply.
 * @returns The manifest paths that actually changed.
 * @throws Propagates any `fs` write error.
 * @typeParam None - this function has no generic type parameters.
 */
export function applyDrift (drift: readonly Drift[]): string[] {
  const changed = new Set<string>()
  for (const finding of drift) {
    for (const site of finding.fixable) {
      if (rewriteSpec(site, finding.target)) {
        changed.add(site.manifestPath)
      }
    }
  }
  return [...changed]
}

/**
 * Regenerates the workspace's TypeScript project references via `nx sync`.
 *
 * @remarks
 * The `--preset=ts` model resolves cross-project imports through TypeScript
 * project references, and those references are maintained by `nx sync` — not
 * by the generators. Without this, a freshly added project's references are
 * stale, so an editor (and a plain `tsc`) cannot resolve `@scope/lib` imports
 * between projects until the user runs `nx sync` by hand.
 *
 * Worth being precise about what this does and does not cover, because the
 * names invite the wrong assumption: `nx sync` runs the workspace's **sync
 * generators**, and the only one a generated workspace registers is
 * `@nx/js:typescript-sync`. It reconciles `tsconfig` project references and
 * nothing else — it has no opinion whatsoever about dependency versions. That
 * is what {@link collectDrift} is for, and why `mnci sync` does both.
 *
 * Non-fatal: `mnci add` calls this after a project is already generated, so a
 * sync failure only warns (with the manual command) rather than failing the run.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Never - a non-zero `nx sync` is reported as a warning, not thrown.
 * @typeParam None - this function has no generic type parameters.
 */
export function syncProjectReferences (workspaceRoot: string): void {
  logger.step('Syncing TypeScript project references (nx sync)')
  if (runShell('npx', ['nx', 'sync'], workspaceRoot) !== 0) {
    logger.warn(
      'nx sync did not complete — run `npx nx sync` yourself so cross-project imports resolve in your editor.'
    )
  }
}

/**
 * Describes one drift finding as a single report line.
 *
 * @param finding - The finding to describe.
 * @returns The formatted line.
 * @throws Never - performs string formatting only.
 * @typeParam None - this function has no generic type parameters.
 */
function describe (finding: Drift): string {
  const sites = [...finding.fixable, ...finding.blocked]
    .map(site => `${site.project === ROOT_LABEL ? ROOT_LABEL : site.project} ${site.spec}`)
    .join(', ')
  return `${finding.name} → ${finding.target} (${finding.reason}); disagreeing: ${sites}`
}

/**
 * Aligns every project's dependency ranges, then syncs TypeScript references.
 *
 * @remarks
 * Two jobs under one command because they are the two halves of "the workspace
 * agrees with itself", and a user should not have to know which mechanism owns
 * which half.
 *
 * The formatter pass at the end is not cosmetic: `eslint --fix` is what runs
 * `@nx/dependency-checks`' own auto-fix, so anything this command converged is
 * immediately re-checked by the rule that guards the same property — and any
 * range still drifted from what is installed gets pinned there rather than left
 * for CI to report.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param options - Parsed CLI options.
 * @returns Nothing.
 * @throws Error when `workspaceRoot` is not an Nx workspace, or the
 * `--ecosystem` flag names something unknown.
 * @typeParam None - this function has no generic type parameters.
 */
export function runSync (workspaceRoot: string, options: SyncOptions): void {
  if (!fileExists(join(workspaceRoot, 'nx.json'))) {
    throw new Error(
      `No nx.json found in ${workspaceRoot} — run 'mnci sync' from the workspace root.`
    )
  }

  const ecosystems = resolveEcosystems(options.ecosystem)
  for (const ecosystem of ecosystems) {
    if (!hasEcosystem(workspaceRoot, ecosystem)) {
      logger.info(`⊘ SKIPPED ${ecosystem} — no ${ecosystem} project in this workspace.`)
    }
  }
  if (ecosystems.includes('go') && hasEcosystem(workspaceRoot, 'go')) {
    logger.success('go — nothing to sync; one root go.mod means one version of every module.')
  }

  const drift = collectDrift(workspaceRoot, ecosystems)

  if (drift.length === 0) {
    logger.success('Every project agrees on every shared dependency version.')
  } else {
    for (const finding of drift) {
      logger.info(`  ${describe(finding)}`)
    }
  }

  if (options.check) {
    if (drift.length > 0) {
      logger.error(
        `${drift.length} package(s) declared at more than one version. Run 'mnci sync' to converge them.`
      )
      process.exitCode = 1
    }
    // --check never runs `nx sync` either: `nx sync:check` is the read-only
    // command for that half, and mnci doctor already calls it.
    return
  }

  const changed = applyDrift(drift)
  for (const path of changed) {
    logger.detail(`updated ${path}`)
  }

  const blocked = drift.flatMap(finding => finding.blocked)
  for (const site of blocked) {
    logger.warn(
      `${site.name} in ${site.project} is declared as '${site.spec}', which is not a plain version range — left unchanged.`
    )
  }

  syncProjectReferences(workspaceRoot)

  if (changed.length > 0) {
    logger.step('Formatting the changed manifests (eslint --fix)')
    runFormatter(workspaceRoot)
  }

  logger.success('Done. Review the changes with `git diff` before committing.')
}
