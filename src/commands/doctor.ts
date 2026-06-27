import { isManagedRepo, loadConfig, saveConfig } from '../engine/config'
import { TEMPLATE_VERSION } from '../engine/constants'
import { discoverProjects } from '../engine/projects'
import { syncToolOwned } from '../engine/sync'
import type { FileSpec, MonorepoVars } from '../engine/types'
import { projectFiles } from '../generators/scaffold'
import { monorepoFiles } from '../templates/monorepo'
import { logger } from '../util/logger'

export interface DoctorOptions {
  apply: boolean
}

/**
 * Detects and (optionally) repairs configuration drift.
 *
 * Re-derives the canonical `tool-owned` files for the monorepo and every project
 * it discovers, then compares them to disk. `scaffold` files (package.json, src,
 * .env, …) are never touched.
 */
export async function runDoctor (options: DoctorOptions): Promise<void> {
  const repoRoot = process.cwd()

  if (!isManagedRepo(repoRoot)) {
    logger.error('No .nx-magic.json found here. Run `doctor` from an nx-magic monorepo root.')
    return
  }

  const config = loadConfig(repoRoot)
  if (!config) {
    logger.error('Could not read .nx-magic.json.')
    return
  }

  const vars: MonorepoVars = {
    workspaceName: config.workspaceName,
    displayName: config.displayName,
    scope: config.scope,
    defaultBase: config.defaultBase,
    nodeVersion: config.nodeVersion,
    azure: config.azure,
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
