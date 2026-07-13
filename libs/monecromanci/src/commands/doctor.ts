import { join } from 'node:path'
import { isManagedRepo, loadConfig, saveConfig } from '../engine/config'
import { DEFAULT_TRIGGER_BRANCHES, OBSOLETE_TOOL_OWNED_PATHS, TEMPLATE_VERSION } from '../engine/constants'
import { ensureCoreDependencies, ensureLegacyPeerDependencies, findMissingCoreDependencies, findSupersededDependencies, isLegacyPeerDependenciesMissing, removeSupersededDependencies } from '../engine/dependenciesHealth'
import { fileExists, readTextSafe, removeFileIfExists, writeFileEnsured } from '../engine/fsx'
import { syncGuide } from '../engine/guide'
import { discoverProjects } from '../engine/projects'
import { mergeManifest } from '../engine/rootPackage'
import { syncToolOwned } from '../engine/sync'
import type { FileSpec, MonecromanciConfig, MonorepoVars } from '../engine/types'
import { projectFiles } from '../generators/scaffold'
import { monorepoFiles } from '../templates/monorepo'
import { logger } from '../util/logger'
import { promptBranchList, promptDriftChoice, renderDiff } from '../util/prompts'

/**
 * Options accepted by {@link runDoctor}.
 *
 * @remarks
 * Mirrors the CLI's `--fix` flag.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface DoctorOptions {
  apply: boolean
}

/**
 * Detects and (optionally) repairs configuration drift.
 *
 * @remarks
 * Re-derives the canonical `tool-owned` files for the monorepo and every project
 * it discovers, then compares them to disk. `scaffold` files (package.json, src,
 * .env, …) are never touched.
 *
 * @param options - Whether to apply fixes (`apply: true`) or only report drift.
 * @returns A promise that resolves once the report has been logged (and, when
 * applying, the repo's tool-owned files repaired).
 * @throws Propagates errors from the underlying file or config operations; the
 * CLI entry point in `cli.ts` catches and reports them.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runDoctor (options: DoctorOptions): Promise<void> {
  const repoRoot = process.cwd()

  if (!isManagedRepo(repoRoot)) {
    logger.error('No .monecromanci.json found here. Run `doctor` from a MoNecromanCI monorepo root.')
    return
  }

  let config = loadConfig(repoRoot)
  if (!config) {
    logger.error('Could not read .monecromanci.json.')
    return
  }

  // The guide travels with every command, even a report-only doctor run.
  syncGuide(repoRoot)

  const { triggerBranches, wasMissing } = await resolveTriggerBranches(repoRoot, config, options.apply)
  if (wasMissing && options.apply) {
    config = { ...config, triggerBranches }
  }

  const vars: MonorepoVars = {
    workspaceName: config.workspaceName,
    displayName:   config.displayName,
    scope:         config.scope,
    defaultBase:   config.defaultBase,
    nodeVersion:   config.nodeVersion,
    ci:            config.ci,
    registry:      config.registry,
    triggerBranches,
  }

  const specs: FileSpec[] = [...monorepoFiles(vars)]
  for (const project of discoverProjects(repoRoot, config)) {
    specs.push(...projectFiles(project.kind, project))
  }

  // Report-only here even when applying: missing files are always recreated
  // below, but drifted files need per-file resolution first (a remembered
  // preference, or an interactive prompt) before anything gets overwritten.
  const report = syncToolOwned(repoRoot, specs, false)

  for (const path of report.missing) {
    logger.warn(`missing: ${path}`)
    if (options.apply) {
      const spec = specs.find((candidate) => candidate.path === path)
      if (spec) {
        writeFileEnsured(join(repoRoot, path), spec.content)
        logger.success(`fixed:   ${path}`)
      }
    }
  }

  const drift = await resolveDrift(repoRoot, config, specs, report.drift, options.apply)
  if (drift.preferences) {
    // Persist immediately: a freshly-chosen "always"/"never" preference must
    // survive even if this run turns out to have no other outstanding issues
    // (which returns early, below, before the end-of-run saveConfig).
    config = { ...config, fileSyncPreferences: drift.preferences }
    saveConfig(repoRoot, config)
  }

  const applied = drift.entries.filter((entry) => entry.outcome === 'applied').map((entry) => entry.path)
  const stillDrift = drift.entries.filter((entry) => entry.outcome === 'drift').map((entry) => entry.path)
  const never = drift.entries.filter((entry) => entry.outcome === 'never').map((entry) => entry.path)
  const alwaysPending = drift.entries.filter((entry) => entry.outcome === 'always-pending').map((entry) => entry.path)

  for (const path of stillDrift) {
    logger.warn(`drift:   ${path}`)
  }
  for (const path of applied) {
    logger.success(`fixed:   ${path}`)
  }
  for (const path of never) {
    logger.info(`skip:    ${path} (remembered preference — never update)`)
  }
  for (const path of alwaysPending) {
    logger.info(`skip:    ${path} (remembered preference — always update; re-run with --fix to apply)`)
  }

  const dependencyIssues = checkDependencyHealth(repoRoot, options.apply)
  const obsoleteIssues = checkObsoletePaths(repoRoot, options.apply)
  const scripts = checkProjectScripts(repoRoot, specs, options.apply)
  const configIssues = wasMissing ? 1 : 0
  // always-pending entries ARE drift — the resolution is just pre-authorized.
  // In report mode they must count as issues (and fail the exit code below):
  // a repo whose tool-owned files don't match the templates is not in sync,
  // no matter how it would be resolved. Not counted when applying, since
  // apply mode already rewrote them (they land in `applied` instead).
  const issues = report.missing.length + stillDrift.length + alwaysPending.length + dependencyIssues + obsoleteIssues + scripts.issues + configIssues

  if (issues === 0) {
    logger.success(`Everything is in sync (${report.ok.length} tool-owned files checked).`)
    return
  }

  if (!options.apply) {
    logger.info(`${issues} issue(s) found. Re-run with --fix to repair (scaffold files are left untouched).`)
    // Non-zero so CI (or any script) can gate on drift: a half-committed or
    // stale tree fails here, in seconds, instead of exploding downstream.
    process.exitCode = 1
    return
  }

  saveConfig(repoRoot, { ...config, templateVersion: TEMPLATE_VERSION })
  const repaired = report.missing.length + applied.length + dependencyIssues + obsoleteIssues + scripts.repaired + configIssues
  const leftoverNote = stillDrift.length > 0 ? ` (${stillDrift.length} left as drift — re-run --fix to decide again)` : ''
  logger.success(`Repaired ${repaired} issue(s); stamped template version ${TEMPLATE_VERSION}.${leftoverNote}`)
}

/** How a single drifted file was resolved by {@link resolveDrift}. */
type DriftOutcome
  = | 'applied'
    | 'never'
    | 'always-pending'
    | 'drift'

/**
 * Outcome of {@link resolveDrift}.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
interface DriftResolution {
  /**
   * Every drifted path with its resolved outcome: `'applied'` (written this
   * run), `'never'` (a remembered or freshly-chosen "never update"
   * preference — never written), `'always-pending'` (a remembered "always
   * update" preference seen during a report-only run — not written this run,
   * but will be on the next `--fix`), or `'drift'` (still needs a decision —
   * report-only with no preference, or an interactive "skip this once").
   */
  entries:      { path: string, outcome: DriftOutcome }[]
  /** The updated preference map, if any interactive "always"/"never" choice changed it; otherwise `undefined`. */
  preferences?: Record<string, 'always' | 'never'>
}

/**
 * Resolves each drifted tool-owned file, consulting (and updating) the
 * repo's remembered per-file preferences.
 *
 * @remarks
 * A remembered `'never'` preference is always honored silently, in both
 * report-only and apply runs. A remembered `'always'` preference is only
 * ever *applied* (written to disk) when `apply` is set — a report-only
 * `doctor` never writes anything, so it's reported as `'always-pending'`
 * instead. An undecided file is only ever prompted for when `apply` is set;
 * report-only leaves it as ordinary `'drift'`. Choosing `'always'`/`'never'`
 * interactively persists the choice into the returned preference map
 * immediately.
 *
 * @param repoRoot - Absolute path to the repo root.
 * @param config - The loaded stamp (read for `fileSyncPreferences`).
 * @param specs - Every tool-owned/scaffold file spec for this repo.
 * @param driftPaths - The drifted paths reported by {@link syncToolOwned}.
 * @param apply - Whether this run applies fixes (`--fix`, or `update`/`ascend`).
 * @returns Every drifted path's outcome, plus the updated preference map when
 * it changed.
 * @throws Propagates any error `promptDriftChoice` raises (e.g. when stdin is
 * not a TTY) or any Node.js `fs` error raised while writing a file.
 * @typeParam None - this function has no generic type parameters.
 */
async function resolveDrift (repoRoot: string, config: MonecromanciConfig, specs: FileSpec[], driftPaths: string[], apply: boolean): Promise<DriftResolution> {
  const specByPath = new Map(specs.map((spec) => [spec.path, spec]))
  const preferences = { ...config.fileSyncPreferences }
  const entries: DriftResolution['entries'] = []
  let preferencesChanged = false

  for (const path of driftPaths) {
    const spec = specByPath.get(path)
    if (!spec) {
      entries.push({ path, outcome: 'drift' })
      continue
    }

    const preference = preferences[path]
    if (preference === 'never') {
      entries.push({ path, outcome: 'never' })
      continue
    }
    if (preference === 'always') {
      if (apply) {
        writeFileEnsured(join(repoRoot, path), spec.content)
        entries.push({ path, outcome: 'applied' })
      } else {
        entries.push({ path, outcome: 'always-pending' })
      }
      continue
    }

    if (!apply) {
      entries.push({ path, outcome: 'drift' })
      continue
    }

    const onDisk = readTextSafe(join(repoRoot, path))
    logger.info(`\n${path}\n${renderDiff(onDisk, spec.content)}`)
    const choice = await promptDriftChoice(path)

    if (choice === 'skip') {
      entries.push({ path, outcome: 'drift' })
      continue
    }
    if (choice === 'never') {
      preferences[path] = 'never'
      preferencesChanged = true
      entries.push({ path, outcome: 'never' })
      continue
    }
    if (choice === 'always') {
      preferences[path] = 'always'
      preferencesChanged = true
    }
    writeFileEnsured(join(repoRoot, path), spec.content)
    entries.push({ path, outcome: 'applied' })
  }

  return { entries, preferences: preferencesChanged ? preferences : undefined }
}

/**
 * Resolves the branches that should trigger CI, prompting once if the stamp
 * doesn't have them yet.
 *
 * @remarks
 * Only prompts (and persists immediately) when `apply` is set — a report-only
 * `doctor` stays side-effect-free and instead flags the missing setting as
 * one more issue, using the default only to compute the drift preview.
 *
 * @param repoRoot - Absolute path to the repo root.
 * @param config - The loaded stamp.
 * @param apply - Whether this run applies fixes (`--fix`, or `update`/`ascend`).
 * @returns The resolved branch list, and whether it was missing beforehand.
 * @throws Propagates any error `promptBranchList` raises (e.g. when stdin is
 * not a TTY) or that `saveConfig` raises writing the stamp.
 * @typeParam None - this function has no generic type parameters.
 */
async function resolveTriggerBranches (repoRoot: string, config: MonecromanciConfig, apply: boolean): Promise<{ triggerBranches: string[], wasMissing: boolean }> {
  if (config.triggerBranches?.length) {
    return { triggerBranches: config.triggerBranches, wasMissing: false }
  }

  if (!apply) {
    logger.warn('triggerBranches not set — run with --fix to choose which branches trigger CI')
    return { triggerBranches: DEFAULT_TRIGGER_BRANCHES, wasMissing: true }
  }

  const triggerBranches = await promptBranchList('Branches that should trigger CI', DEFAULT_TRIGGER_BRANCHES)
  saveConfig(repoRoot, { ...config, triggerBranches })
  logger.success('set triggerBranches in .monecromanci.json')
  return { triggerBranches, wasMissing: true }
}

/**
 * Reports (and with `shouldApply`, repairs) dependency problems that break
 * `npm install` even when every tool-owned file is in sync.
 *
 * @remarks
 * Two checks: superseded lint packages left over from before adoption (they
 * peer-conflict with the pinned toolchain — e.g. `eslint-config-standard`
 * requires `eslint-plugin-n@^15||^16` while the toolchain pins `^18`), and a
 * `.npmrc` missing `legacy-peer-deps=true` (ESLint 10 is ahead of some
 * plugins' declared peer ranges).
 *
 * @param repoRoot - Absolute path to the monorepo root.
 * @param shouldApply - Whether to repair the problems or only report them.
 * @returns The number of issues found.
 * @throws Propagates any Node.js `fs` error raised while repairing.
 * @typeParam None - this function has no generic type parameters.
 */
function checkDependencyHealth (repoRoot: string, shouldApply: boolean): number {
  let issues = 0

  const superseded = shouldApply ? removeSupersededDependencies(repoRoot) : findSupersededDependencies(repoRoot)
  for (const name of superseded) {
    issues += 1
    if (shouldApply) {
      logger.success(`removed superseded lint package '${name}' (replaced by the tool-owned eslint.config.mjs)`)
    } else {
      logger.warn(`superseded lint package '${name}' conflicts with the pinned toolchain — \`npm install\` will fail until it is removed`)
    }
  }

  if (isLegacyPeerDependenciesMissing(repoRoot)) {
    issues += 1
    if (shouldApply) {
      ensureLegacyPeerDependencies(repoRoot)
      logger.success('added legacy-peer-deps=true to .npmrc (ESLint 10 is ahead of some plugins\' peer ranges)')
    } else {
      logger.warn('.npmrc is missing legacy-peer-deps=true — `npm install` may fail on ESLint peer ranges')
    }
  }

  const missingCore = shouldApply ? ensureCoreDependencies(repoRoot) : findMissingCoreDependencies(repoRoot)
  for (const name of missingCore) {
    issues += 1
    if (shouldApply) {
      logger.success(`added missing devDependency '${name}' (the shared configs and CI scripts resolve from it)`)
    } else {
      logger.warn(`devDependency '${name}' is missing — the shared eslint/tsconfig/jest configs and CI scripts resolve from it`)
    }
  }

  return issues
}

/**
 * Reports (and with `shouldApply`, removes) root files a prior template
 * version generated but the current one no longer produces.
 *
 * @remarks
 * See {@link OBSOLETE_TOOL_OWNED_PATHS} — a hardcoded, append-only list, not a
 * generic diff-driven prune, so doctor can never delete a path it didn't
 * itself create in some prior template version.
 *
 * @param repoRoot - Absolute path to the monorepo root.
 * @param shouldApply - Whether to delete the files or only report them.
 * @returns The number of obsolete paths found.
 * @throws Propagates any Node.js `fs` error raised while deleting.
 * @typeParam None - this function has no generic type parameters.
 */
function checkObsoletePaths (repoRoot: string, shouldApply: boolean): number {
  let issues = 0

  for (const path of OBSOLETE_TOOL_OWNED_PATHS) {
    const absolute = join(repoRoot, path)
    if (!fileExists(absolute)) {
      continue
    }

    issues += 1
    if (shouldApply) {
      removeFileIfExists(absolute)
      logger.success(`removed: ${path} (now referenced from the monecromanci package instead)`)
    } else {
      logger.warn(`obsolete: ${path} (no longer generated — re-run with --fix to remove)`)
    }
  }

  return issues
}

/** {@link checkProjectScripts}'s combined issue and repair counts. */
interface ScriptCheckResult {
  issues:   number
  repaired: number
}

/**
 * Checks (and with `shouldApply`, repairs) every project's package.json
 * `scripts` against its canonical template.
 *
 * @remarks
 * A project's package.json is `scaffold`-owned (create-once) so nothing else
 * in `doctor` ever revisits it — when a template's script command changes
 * (e.g. adding a build step), an already-existing project silently keeps the
 * stale one forever, with no warning until something downstream breaks.
 * Scoped to project manifests only, not the monorepo root's: `resurrect`
 * already merges the root's canonical scripts once at adoption time, and
 * root-level script drift hasn't been observed as a real problem the way
 * per-project build scripts have. Delegates to {@link mergeManifest}, whose
 * semantics are already safe here: a genuinely missing script key is added;
 * an existing key whose content differs is only flagged, never overwritten,
 * since it may be a deliberate per-project override — that half is never
 * "repaired" even with `--fix`.
 *
 * @param repoRoot - Absolute path to the monorepo root.
 * @param specs - The full expected file-spec list (monorepo + every project).
 * @param shouldApply - Whether to add missing script keys, or only report.
 * @returns The combined issue and repair counts.
 * @throws Propagates any Node.js `fs` error raised while writing a
 * package.json.
 * @typeParam None - this function has no generic type parameters.
 */
function checkProjectScripts (repoRoot: string, specs: FileSpec[], shouldApply: boolean): ScriptCheckResult {
  let issues = 0
  let repaired = 0

  for (const spec of specs) {
    if (!spec.path.endsWith('/package.json') || !fileExists(join(repoRoot, spec.path))) {
      continue
    }

    const scripts = (JSON.parse(spec.content) as { scripts?: Record<string, string> }).scripts
    if (!scripts) {
      continue
    }

    const directory = join(repoRoot, spec.path.slice(0, -'/package.json'.length))
    const { added, drifted } = mergeManifest(directory, { scripts }, { dryRun: !shouldApply })

    issues += added.length + drifted.length
    repaired += added.length
    for (const key of added) {
      if (shouldApply) {
        logger.success(`fixed:   ${spec.path} (${key})`)
      } else {
        logger.warn(`missing: ${spec.path} (${key}) — the canonical template now includes it`)
      }
    }
  }

  return { issues, repaired }
}
