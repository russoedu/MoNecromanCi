#!/usr/bin/env node

/**
 * Step 01 — Preparation.
 *
 * Resolves the git range, the Nx affected project set, classifies every project
 * from its tags, and writes a reusable context manifest consumed by every later
 * step. Also emits the pipeline variables used for step gating and prints a
 * human-readable execution plan so a run can be understood at a glance.
 *
 * Run locally with `npm run pipeline:plan` (after `npm ci`) to preview the plan
 * without pushing.
 */

import process from 'node:process'
import {
  banner,
  log,
  section,
  setBuildNumber,
  setVariables,
  table,
  writeJson,
} from './lib/_h.mjs'
import {
  buildContextManifest,
  CONTEXT_FILE_PATH,
  describeProjectAction,
  describeProjectType,
  enrichProject,
} from './lib/context.mjs'
import {
  resolveAffectedProjects,
  resolveAllProjects,
  resolveBaseCommit,
  resolveEffectiveBranchName,
  resolveHeadCommit,
  resolveProjectMetadata,
} from './lib/nx.mjs'

/**
 * Resolves and enriches every project in the workspace.
 *
 * @param {string[]} projectNames All Nx project names.
 * @param {Set<string>} affectedSet The affected project names.
 * @param {string} branchName The effective branch name.
 * @returns {Array<Record<string, any>>} Returns enriched project data.
 */
function resolvePipelineProjects (projectNames, affectedSet, branchName) {
  const projects = []

  for (const projectName of [...projectNames].sort((left, right) => left.localeCompare(right))) {
    const metadata = resolveProjectMetadata(projectName)
    if (!metadata) {
      log(`[projects] Skipping ${projectName}: no Nx metadata resolved`)
      continue
    }

    projects.push(enrichProject(metadata, affectedSet.has(projectName), branchName))
  }

  return projects
}

/**
 * Resolves the build number from releasable project versions.
 *
 * @param {Record<string, any>} context The context manifest.
 * @returns {string} Returns the build number.
 */
function resolveBuildNumber (context) {
  const releasable = context.projects
    .filter(project => !project.ignored)
    .filter(project => project.type.functionApp || project.type.reactApp || project.type.externalPackage)
    .filter(project => project.affected && project.version)

  if (releasable.length === 0) {
    return process.env.BUILD_BUILDNUMBER || 'monorepo-no-affected'
  }

  return releasable.map(project => `${project.name}_${project.version}`).join('-')
}

/**
 * Builds the pipeline variables emitted for step gating.
 *
 * @param {Record<string, any>} context The context manifest.
 * @returns {{name: string, value: string}[]} Returns the pipeline variables.
 */
function buildPipelineVariables (context) {
  const variables = [
    { name: 'MONOREPO_CONTEXT_FILE', value: CONTEXT_FILE_PATH },
    { name: 'NX_BASE', value: context.baseCommit },
    { name: 'NX_HEAD', value: context.headCommit },
    { name: 'HAS_AFFECTED', value: String(context.hasAffected) },
    { name: 'AFFECTED_PROJECTS', value: context.affectedProjects.join(',') },
    { name: 'FUNCTION_APPS', value: context.groups.functionApps.join(',') },
    { name: 'NODE_APPS', value: context.groups.nodeApps.join(',') },
    { name: 'REACT_APPS', value: context.groups.reactApps.join(',') },
    { name: 'INTERNAL_PACKAGES', value: context.groups.internalPackages.join(',') },
    { name: 'EXTERNAL_PACKAGES', value: context.groups.externalPackages.join(',') },
    { name: 'IGNORED_PROJECTS', value: context.groups.ignoredProjects.join(',') },
    { name: 'HAS_FUNCTION_APPS', value: String(context.groups.functionApps.length > 0) },
    { name: 'HAS_NODE_APPS', value: String(context.groups.nodeApps.length > 0) },
    { name: 'HAS_REACT_APPS', value: String(context.groups.reactApps.length > 0) },
    { name: 'HAS_INTERNAL_PACKAGES', value: String(context.groups.internalPackages.length > 0) },
    { name: 'HAS_PUBLISHABLE_LIBS', value: String(context.groups.externalPackages.length > 0) },
  ]

  for (const project of context.projects) {
    variables.push({ name: `HAS_${project.sanitizedName}`, value: String(project.affected && !project.ignored) })
  }

  return variables
}

/**
 * Prints the execution plan derived from the context manifest.
 *
 * @param {Record<string, any>} context The context manifest.
 */
function printExecutionPlan (context) {
  section('Execution plan')

  table(context.projects.map(project => ({
    project:  project.name,
    type:     describeProjectType(project),
    affected: project.affected && !project.ignored ? 'yes' : 'no',
    version:  project.version || 'n/a',
    action:   project.affected && !project.ignored ? describeProjectAction(project) : '—',
  })))
}

/**
 * Runs preparation discovery and emits the reusable pipeline context.
 */
function main () {
  banner('[01] Preparation — resolving monorepo context')
  log(`Platform: ${process.platform}, cwd: ${process.cwd()}`)

  const branchName = resolveEffectiveBranchName()
  const headCommit = resolveHeadCommit()
  const baseCommit = resolveBaseCommit(headCommit)
  log(`Branch: ${branchName || '(unknown)'}`)
  log(`Range:  ${baseCommit} .. ${headCommit}`)

  const affectedProjects = resolveAffectedProjects(baseCommit, headCommit)
  const affectedSet = new Set(affectedProjects)
  log(`Affected (${affectedProjects.length}): ${affectedProjects.join(', ') || '(none)'}`)

  const projectNames = resolveAllProjects()
  log(`All projects (${projectNames.length}): ${projectNames.join(', ')}`)

  const projects = resolvePipelineProjects(projectNames, affectedSet, branchName)
  const context = buildContextManifest({ baseCommit, branchName, headCommit, projects })

  writeJson(CONTEXT_FILE_PATH, context)
  log(`Context written: ${CONTEXT_FILE_PATH}`)

  printExecutionPlan(context)

  const buildNumber = resolveBuildNumber(context)
  setBuildNumber(buildNumber)
  log(`Build number: ${buildNumber}`)

  section('Pipeline variables')
  setVariables(buildPipelineVariables(context))

  banner(context.hasAffected
    ? `[01] Preparation complete — ${context.affectedProjects.length} affected project(s)`
    : '[01] Preparation complete — no affected projects, downstream steps will skip')
}

main()
