import { isManagedRepo, loadConfig, saveConfig } from '../engine/config'
import { TEMPLATE_VERSION } from '../engine/constants'
import { ensureLegacyPeerDependencies, findSupersededDependencies, isLegacyPeerDependenciesMissing, removeSupersededDependencies } from '../engine/dependenciesHealth'
import { syncGuide } from '../engine/guide'
import { discoverProjects } from '../engine/projects'
import { syncToolOwned } from '../engine/sync'
import type { FileSpec, MonorepoVars } from '../engine/types'
import { projectFiles } from '../generators/scaffold'
import { monorepoFiles } from '../templates/monorepo'
import { logger } from '../util/logger'

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

  const config = loadConfig(repoRoot)
  if (!config) {
    logger.error('Could not read .monecromanci.json.')
    return
  }

  // The guide travels with every command, even a report-only doctor run.
  syncGuide(repoRoot)

  const vars: MonorepoVars = {
    workspaceName: config.workspaceName,
    displayName:   config.displayName,
    scope:         config.scope,
    defaultBase:   config.defaultBase,
    nodeVersion:   config.nodeVersion,
    ci:            config.ci,
    registry:      config.registry,
  }

  const specs: FileSpec[] = [...monorepoFiles(vars)]
  for (const project of discoverProjects(repoRoot, config)) {
    specs.push(...projectFiles(project.kind, project))
  }

  const report = syncToolOwned(repoRoot, specs, options.apply)

  for (const path of report.missing) {
    logger.warn(`missing: ${path}`)
  }
  for (const path of report.drift) {
    logger.warn(`drift:   ${path}`)
  }
  for (const path of report.fixed) {
    logger.success(`fixed:   ${path}`)
  }

  const dependencyIssues = checkDependencyHealth(repoRoot, options.apply)
  const issues = report.missing.length + report.drift.length + dependencyIssues

  if (issues === 0) {
    logger.success(`Everything is in sync (${report.ok.length} tool-owned files checked).`)
    return
  }

  if (!options.apply) {
    logger.info(`${issues} issue(s) found. Re-run with --fix to repair (scaffold files are left untouched).`)
    return
  }

  saveConfig(repoRoot, { ...config, templateVersion: TEMPLATE_VERSION })
  logger.success(`Repaired ${issues} issue(s); stamped template version ${TEMPLATE_VERSION}.`)
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

  return issues
}
