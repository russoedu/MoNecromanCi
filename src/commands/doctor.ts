import { isManagedRepo, loadConfig, saveConfig } from '../engine/config'
import { TEMPLATE_VERSION } from '../engine/constants'
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

  const issues = report.missing.length + report.drift.length

  if (issues === 0) {
    logger.success(`Everything is in sync (${report.ok.length} tool-owned files checked).`)
    return
  }

  if (!options.apply) {
    logger.info(`${issues} issue(s) found. Re-run with --fix to repair (scaffold files are left untouched).`)
    return
  }

  saveConfig(repoRoot, { ...config, templateVersion: TEMPLATE_VERSION })
  logger.success(`Repaired ${report.fixed.length} file(s); stamped template version ${TEMPLATE_VERSION}.`)
}
