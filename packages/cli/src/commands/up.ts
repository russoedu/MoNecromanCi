import { join } from 'node:path'
import { Separator, checkbox } from '@inquirer/prompts'
import {
  PEER_SECTION,
  collectInventory,
  hasEcosystem,
  isAliasedInstall,
  isWorkspaceProject,
  resolvedVersion,
  rewriteSpec,
  type DependencySite,
  type Ecosystem
} from '../deps/inventory'
import { latestVersions } from '../deps/registry'
import {
  UPDATE_KINDS,
  UPDATE_KIND_LABELS,
  classify,
  highestSpec,
  isNewer,
  rangeOperator,
  specVersion,
  type UpdateKind
} from '../deps/semver'
import { runFormatter, runShell } from '../nx'
import { fileExists, readJson } from '../util/fsx'
import { logger } from '../util/logger'
import { resolveEcosystems, syncProjectReferences } from './sync'

/**
 * Options accepted by `mnci up`.
 *
 * @remarks
 * `install` is inverted by commander: the flag is `--no-install`, so the field
 * is `true` unless the user asked to skip the reinstall. Compared against
 * `false` explicitly at the call site for that reason.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface UpOptions {
  /** Report only; never prompt and never write. */
  check?: boolean
  /** Select every available update without prompting. */
  yes?: boolean
  /** Restrict the run to one ecosystem. */
  ecosystem?: string
  /** Commander sets this to `false` for `--no-install`. */
  install?: boolean
}

/**
 * One package with a newer release available.
 *
 * @remarks
 * `current` is one version even though `sites` may declare several ranges: it
 * is what the workspace actually resolved, which is the only version an upgrade
 * is meaningfully measured from. A workspace whose sites genuinely disagree is
 * `mnci sync`'s problem, not this command's.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface Outdated {
  /** The package name. */
  name: string
  /** Which ecosystem it belongs to. */
  ecosystem: Ecosystem
  /** The version currently in use. */
  current: string
  /** The newest published version. */
  latest: string
  /** Which `npm-check` section this upgrade belongs in. */
  kind: UpdateKind
  /** Every place it is declared — the column `npm-check` does not have. */
  sites: DependencySite[]
}

/**
 * The version of a package the workspace is effectively on.
 *
 * @remarks
 * Prefers what is resolved over what is declared, because a range says what
 * would be acceptable while the resolved version says what is actually running
 * — and an upgrade report about the former would be about nothing the user has.
 * Falls back to the highest declared range for a package nothing has installed.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param sites - Every declaration of one package.
 * @returns The current version, or `undefined` when it cannot be determined.
 * @throws Never - every lookup failure yields `undefined`.
 * @typeParam None - this function has no generic type parameters.
 */
function currentVersion (
  workspaceRoot: string,
  sites: readonly DependencySite[]
): string | undefined {
  const installed = resolvedVersion(workspaceRoot, sites[0].ecosystem, sites[0].name)
  if (installed) {
    return installed
  }
  if (sites[0].ecosystem === 'go') {
    // The root go.mod pins exactly and declares each module once, so its spec
    // IS the current version — but it carries a leading `v`, which every
    // version comparison here would otherwise reject as unparseable, silently
    // reporting the whole Go ecosystem as having no updates.
    return bare(sites[0].spec)
  }
  const highest = highestSpec(sites.map(site => site.spec))
  return highest ? specVersion(highest) : undefined
}

/**
 * Finds every package with a newer release, across every ecosystem present.
 *
 * @remarks
 * Indirect Go modules are excluded: `go mod tidy` owns them, so offering one
 * for a direct upgrade would be offering an edit the toolchain undoes.
 *
 * So is a package declared **only** as a peer dependency. A peer range states
 * which versions a published package supports, not which one this workspace
 * uses, so there is no upgrade to offer — and writing one would narrow the
 * package's compatibility. A package that is both a peer somewhere and a real
 * dependency elsewhere is still offered; `applyUpdate` then rewrites the real
 * declarations and leaves the peer range alone.
 *
 * An ecosystem whose toolchain is missing yields nothing rather than failing —
 * `latestVersions` resolves an empty map — and `runUp` reports that as a loud
 * SKIPPED so an absent Flutter SDK is never mistaken for "everything is current".
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param ecosystems - Which ecosystems to inspect.
 * @returns A promise of every outdated package, newest section first.
 * @throws Never - unreadable manifests and dead toolchains are skipped.
 * @typeParam None - this function has no generic type parameters.
 */
export async function collectOutdated (
  workspaceRoot: string,
  ecosystems: readonly Ecosystem[]
): Promise<Outdated[]> {
  const present = ecosystems.filter(ecosystem => hasEcosystem(workspaceRoot, ecosystem))
  const inventory = collectInventory(workspaceRoot, present)

  const outdated: Outdated[] = []
  for (const ecosystem of present) {
    const forEcosystem = [...inventory].filter(([name, sites]) =>
      offerable(workspaceRoot, ecosystem, name, sites)
    )
    const latest = await latestVersions(
      ecosystem,
      forEcosystem.map(([name]) => name),
      workspaceRoot
    )
    outdated.push(...upgradable(workspaceRoot, ecosystem, forEcosystem, latest))
  }

  return outdated.toSorted(
    (left, right) =>
      UPDATE_KINDS.indexOf(left.kind) - UPDATE_KINDS.indexOf(right.kind) ||
      left.name.localeCompare(right.name)
  )
}

/**
 * Whether a package is one this command may offer an upgrade for.
 *
 * @remarks
 * Four exclusions, each one a wrong row the first real run produced or would
 * have produced:
 *
 * - **A different ecosystem's entry**, since the registry answer being matched
 *   against was fetched for this one.
 * - **An indirect Go module**, which `go mod tidy` owns.
 * - **A package declared only as a peer**, whose range states which versions a
 *   published package supports rather than which one this workspace uses.
 * - **A workspace project**, which `nx release` versions, and an **aliased
 *   install**, whose manifest key names a different package than the one on
 *   disk — the registry answer for that key is about something else entirely.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param ecosystem - The ecosystem currently being processed.
 * @param name - The package name.
 * @param sites - Every declaration of it.
 * @returns `true` when an upgrade may be offered.
 * @throws Never - only reads the filesystem.
 * @typeParam None - this function has no generic type parameters.
 */
function offerable (
  workspaceRoot: string,
  ecosystem: Ecosystem,
  name: string,
  sites: readonly DependencySite[]
): boolean {
  if (sites[0].ecosystem !== ecosystem || sites[0].section === 'indirect') {
    return false
  }
  if (sites.every(site => site.section === PEER_SECTION)) {
    return false
  }
  if (ecosystem !== 'npm') {
    return true
  }
  return !isWorkspaceProject(workspaceRoot, name) && !isAliasedInstall(workspaceRoot, name)
}

/**
 * Drops Go's leading `v` so a version can be compared like any other.
 *
 * @remarks
 * `v1.2.3` and `1.2.3` are the same release. Without this, every Go module
 * would read as unparseable and the whole ecosystem would silently report no
 * updates — the quiet-failure shape this codebase keeps running into.
 *
 * @param version - The version as its ecosystem spells it.
 * @returns The version without a leading `v`.
 * @throws Never - performs a string replacement only.
 * @typeParam None - this function has no generic type parameters.
 */
function bare (version: string): string {
  return version.replace(/^v/, '')
}

/**
 * Selects the packages in one ecosystem that have a newer release.
 *
 * @remarks
 * Split out of {@link collectOutdated} so the per-package loop is not nested
 * inside the per-ecosystem one. Go's `v` prefix is stripped on both sides before
 * comparing: `v1.2.3` and `1.2.3` are the same release, and a comparison that
 * did not know that would report every Go module as unparseable.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param ecosystem - The ecosystem being processed.
 * @param declared - Its inventory entries, as name/sites pairs.
 * @param latest - The latest version per package name.
 * @returns The packages with an upgrade available.
 * @throws Never - a package with no known latest version is skipped.
 * @typeParam None - this function has no generic type parameters.
 */
function upgradable (
  workspaceRoot: string,
  ecosystem: Ecosystem,
  declared: ReadonlyArray<[string, DependencySite[]]>,
  latest: ReadonlyMap<string, string>
): Outdated[] {
  const outdated: Outdated[] = []

  for (const [name, sites] of declared) {
    const newest = latest.get(name)
    const current = currentVersion(workspaceRoot, sites)
    if (!newest || !current || !isNewer(bare(newest), bare(current))) {
      continue
    }
    outdated.push({
      name,
      ecosystem,
      current,
      latest: newest,
      kind: classify(bare(current), bare(newest)),
      sites
    })
  }
  return outdated
}

/**
 * Renders one report row, column-aligned against its siblings.
 *
 * @remarks
 * Hand-rolled padding rather than a table dependency: the CLI ships three
 * runtime dependencies on purpose, and this is four `padEnd` calls.
 *
 * @param entry - The package to render.
 * @param widths - The column widths computed across the whole section.
 * @returns The formatted row.
 * @throws Never - performs string formatting only.
 * @typeParam None - this function has no generic type parameters.
 */
function row (entry: Outdated, widths: { name: number, section: number, current: number }): string {
  const sections = [...new Set(entry.sites.map(site => site.section))].join('/')
  const projects = [...new Set(entry.sites.map(site => site.project))].join(', ')
  return [
    entry.name.padEnd(widths.name),
    sections.padEnd(widths.section),
    `${entry.current.padStart(widths.current)}  ›  ${entry.latest}`,
    projects
  ].join('  ')
}

/**
 * Computes the column widths for a set of rows.
 *
 * @param entries - The rows about to be rendered.
 * @returns The width of each padded column.
 * @throws Never - performs arithmetic only.
 * @typeParam None - this function has no generic type parameters.
 */
function columnWidths (entries: readonly Outdated[]): {
  name: number
  section: number
  current: number
} {
  return {
    name: widthOf(entries.map(entry => entry.name)),
    section: widthOf(
      entries.map(entry => [...new Set(entry.sites.map(site => site.section))].join('/'))
    ),
    current: widthOf(entries.map(entry => entry.current))
  }
}

/**
 * Longest string in a set, or zero for an empty one.
 *
 * @param values - The strings to measure.
 * @returns The greatest length.
 * @throws Never - performs arithmetic only.
 * @typeParam None - this function has no generic type parameters.
 */
function widthOf (values: readonly string[]): number {
  return Math.max(0, ...values.map(value => value.length))
}

/**
 * Prints the grouped report `npm-check` prints, plus the projects column.
 *
 * @remarks
 * Also what a non-TTY invocation gets instead of a prompt, so a piped or
 * scripted run reports rather than hanging on a question nobody can answer.
 *
 * @param outdated - Everything with an update available.
 * @returns Nothing.
 * @throws Never - writes to stdout only.
 * @typeParam None - this function has no generic type parameters.
 */
export function reportOutdated (outdated: readonly Outdated[]): void {
  const widths = columnWidths(outdated)
  for (const kind of UPDATE_KINDS) {
    const section = outdated.filter(entry => entry.kind === kind)
    if (section.length === 0) {
      continue
    }
    const { title, blurb } = UPDATE_KIND_LABELS[kind]
    logger.info('')
    logger.info(`${title}  ${blurb}`)
    for (const entry of section) {
      logger.info(`  ${row(entry, widths)}`)
    }
  }
}

/**
 * Prompts for which updates to apply, grouped the way `npm-check -u` groups them.
 *
 * @param outdated - Everything with an update available.
 * @returns A promise of the selected packages.
 * @throws Propagates any error `@inquirer/prompts` raises (e.g. non-TTY stdin).
 * @typeParam None - this function has no generic type parameters.
 */
async function promptForUpdates (outdated: readonly Outdated[]): Promise<Outdated[]> {
  const widths = columnWidths(outdated)
  const choices: Array<Separator | { name: string, value: Outdated }> = []

  for (const kind of UPDATE_KINDS) {
    const section = outdated.filter(entry => entry.kind === kind)
    if (section.length === 0) {
      continue
    }
    const { title, blurb } = UPDATE_KIND_LABELS[kind]
    choices.push(new Separator(`\n${title}  ${blurb}`))
    for (const entry of section) {
      choices.push({ name: row(entry, widths), value: entry })
    }
  }

  return await checkbox({
    message: 'Choose which packages to update.',
    choices,
    pageSize: 20
  })
}

/**
 * Applies one selected update to every manifest that declares the package.
 *
 * @remarks
 * Every site, not just the first: the whole reason this command shows a
 * projects column is that a package usually has several declarations, and
 * updating one of them is how a workspace acquires the version drift
 * `mnci sync` then has to repair.
 *
 * Go is the exception and is handled by the caller — its version lives in the
 * root `go.mod`'s require block, which is the toolchain's file to write.
 *
 * @param entry - The selected package.
 * @returns The manifest paths that changed.
 * @throws Propagates any `fs` write error.
 * @typeParam None - this function has no generic type parameters.
 */
function applyUpdate (entry: Outdated): string[] {
  const changed: string[] = []
  for (const site of entry.sites) {
    if (!site.rewritable) {
      continue
    }
    // Keep whatever operator this site already used, so an exact pin is never
    // silently widened into a range.
    const spec = `${rangeOperator(site.spec)}${entry.latest}`
    if (rewriteSpec(site, spec)) {
      changed.push(site.manifestPath)
    }
  }
  return changed
}

/**
 * Reinstalls each ecosystem whose manifests changed.
 *
 * @remarks
 * Editing a manifest without reinstalling leaves the workspace in the one state
 * this whole feature exists to prevent: declared and resolved disagreeing.
 *
 * The Python step goes through the workspace's own `python:install` root script
 * rather than a bare `pip install`, because that script is what installs every
 * project editable in one resolver pass — a per-project install would resolve
 * each project's requirements in isolation.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param ecosystems - The ecosystems whose manifests were edited.
 * @returns Nothing.
 * @throws Never - a failed install is reported as a warning.
 * @typeParam None - this function has no generic type parameters.
 */
function reinstall (workspaceRoot: string, ecosystems: ReadonlySet<Ecosystem>): void {
  const commands: Array<[Ecosystem, string, string[]]> = [
    ['npm', 'npm', ['install']],
    ['pip', 'npm', ['run', 'python:install']],
    ['pub', 'flutter', ['pub', 'get']],
    ['go', 'go', ['mod', 'tidy']]
  ]

  for (const [ecosystem, command, arguments_] of commands) {
    if (!ecosystems.has(ecosystem)) {
      continue
    }
    if (ecosystem === 'pip' && !hasPythonInstallScript(workspaceRoot)) {
      logger.warn(
        "This workspace has no 'python:install' script — run 'mnci upgrade' to add it, then reinstall by hand."
      )
      continue
    }
    logger.step(`Reinstalling ${ecosystem} dependencies (${command} ${arguments_.join(' ')})`)
    if (runShell(command, arguments_, workspaceRoot) !== 0) {
      logger.warn(
        `${command} ${arguments_.join(' ')} failed — the manifests were updated, so re-run it once the cause is fixed.`
      )
    }
  }
}

/**
 * Whether the workspace's root manifest carries the `python:install` script.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns `true` when the script exists.
 * @throws Never - an unreadable manifest yields `false`.
 * @typeParam None - this function has no generic type parameters.
 */
function hasPythonInstallScript (workspaceRoot: string): boolean {
  try {
    const manifest = readJson<{ scripts?: Record<string, string> }>(
      join(workspaceRoot, 'package.json')
    )
    return manifest.scripts?.['python:install'] !== undefined
  } catch {
    return false
  }
}

/**
 * Upgrades Go modules through the toolchain rather than by editing `go.mod`.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param entries - The selected Go modules.
 * @returns Nothing.
 * @throws Never - a failed `go get` is reported as a warning.
 * @typeParam None - this function has no generic type parameters.
 */
function applyGoUpdates (workspaceRoot: string, entries: readonly Outdated[]): void {
  for (const entry of entries) {
    logger.step(`go get ${entry.name}@${entry.latest}`)
    if (runShell('go', ['get', `${entry.name}@${entry.latest}`], workspaceRoot) !== 0) {
      logger.warn(`go get ${entry.name}@${entry.latest} failed — left at ${entry.current}.`)
    }
  }
}

/**
 * Reports every outdated dependency across the workspace and offers to update.
 *
 * @remarks
 * Modelled on `npm-check -u`: the same four sections in the same order, the
 * same interactive multiselect. The addition is the last column — every project
 * that declares the package — which is the question `npm-check` cannot answer
 * in a monorepo and the one that actually decides whether an upgrade is safe.
 *
 * `--check` is not just a flag: it is also the automatic behaviour when stdout
 * is not a TTY, so a CI step or a piped invocation reports instead of hanging
 * on a prompt no one can answer.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param options - Parsed CLI options.
 * @returns A promise that resolves when the run completes.
 * @throws Error when `workspaceRoot` is not an Nx workspace, or the
 * `--ecosystem` flag names something unknown.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runUp (workspaceRoot: string, options: UpOptions): Promise<void> {
  if (!fileExists(join(workspaceRoot, 'nx.json'))) {
    throw new Error(`No nx.json found in ${workspaceRoot} — run 'mnci up' from the workspace root.`)
  }

  const ecosystems = resolveEcosystems(options.ecosystem)
  for (const ecosystem of ecosystems) {
    if (!hasEcosystem(workspaceRoot, ecosystem)) {
      logger.info(`⊘ SKIPPED ${ecosystem} — no ${ecosystem} project in this workspace.`)
    }
  }

  logger.step('Querying registries for the latest published versions')
  const outdated = await collectOutdated(workspaceRoot, ecosystems)

  if (outdated.length === 0) {
    logger.success('Every dependency is on its latest published version.')
    return
  }

  const readOnly = options.check ?? !process.stdout.isTTY
  if (readOnly) {
    reportOutdated(outdated)
    logger.info('')
    logger.info(`${outdated.length} package(s) have a newer release. Run 'mnci up' to update them.`)
    return
  }

  const selected = options.yes ? [...outdated] : await promptForUpdates(outdated)
  if (selected.length === 0) {
    logger.info('Nothing selected; no manifest was changed.')
    return
  }

  const goSelections = selected.filter(entry => entry.ecosystem === 'go')
  const changed = selected
    .filter(entry => entry.ecosystem !== 'go')
    .flatMap(entry => applyUpdate(entry))

  const changedManifests = new Set(changed)
  for (const path of changedManifests) {
    logger.detail(`updated ${path}`)
  }
  applyGoUpdates(workspaceRoot, goSelections)

  if (options.install !== false) {
    reinstall(workspaceRoot, new Set(selected.map(entry => entry.ecosystem)))
  }

  if (changed.length > 0) {
    syncProjectReferences(workspaceRoot)
    logger.step('Formatting the changed manifests (eslint --fix)')
    runFormatter(workspaceRoot)
  }

  logger.success(
    `Updated ${selected.length} package(s). Review the changes with \`git diff\` before committing.`
  )
}
