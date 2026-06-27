#!/usr/bin/env node

/**
 * Monorepo context model: project classification, the persisted context file,
 * and the filter helpers every build step uses to decide what to act on.
 *
 * Projects are classified purely from their Nx tags. A single canonical tag
 * (`type:function-app`, `type:react-app`, `type:publishable-lib`,
 * `type:internal-lib`, `ci:ignore`) is recommended, but legacy descriptive tags
 * are still recognised through the alias table so existing repos keep working.
 */

import path from 'node:path'
import process from 'node:process'
import { readJsonSafe } from './_h.mjs'

const WORKSPACE_ROOT = process.cwd()

/** Default location of the persisted context file. */
export const CONTEXT_FILE_PATH = path.join(WORKSPACE_ROOT, '.build-templates', '01-preparation.context.json')

/** Tag aliases mapping legacy and canonical tags onto pipeline categories. */
export const PROJECT_TAG_ALIASES = {
  externalPackages: ['type:publishable-lib', 'external lib', 'external package', 'external', 'publishable lib', 'publishable package', 'publishable'],
  functionApps:     ['type:function-app', 'api', 'function', 'function app', 'function-app', 'backend', 'back-end'],
  ignore:           ['ci:ignore', 'ignore'],
  internalPackages: ['type:internal-lib', 'internal lib', 'internal package', 'internal'],
  reactApps:        ['type:react-app', 'react app', 'react', 'frontend', 'front-end', 'app'],
}

/**
 * Normalises a tag for case-insensitive comparison.
 *
 * @param {string} tag The raw tag value.
 * @returns {string} Returns the normalised tag.
 */
function normalizeTag (tag) {
  return String(tag || '').trim().toLowerCase()
}

/**
 * Returns whether any project tag matches one of the supplied aliases.
 *
 * @param {string[]} tags The project tags.
 * @param {string[]} aliases The accepted aliases.
 * @returns {boolean} Returns true when a match exists.
 */
function hasTagAlias (tags, aliases) {
  const normalizedTags = new Set(tags.map(normalizeTag))

  return aliases.some(alias => normalizedTags.has(normalizeTag(alias)))
}

/**
 * Sanitises a project name into an Azure variable token.
 *
 * @param {string} projectName The raw project name.
 * @returns {string} Returns the sanitised token.
 */
export function sanitizeVariableToken (projectName) {
  return String(projectName || '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
}

/**
 * Resolves a field from a project's package manifest.
 *
 * @param {string} projectRoot The project root path.
 * @param {string} field The package.json field to read.
 * @returns {any} Returns the field value or undefined.
 */
function readPackageField (projectRoot, field) {
  const packageJsonPath = path.join(WORKSPACE_ROOT, projectRoot, 'package.json')

  return readJsonSafe(packageJsonPath)[field]
}

/**
 * Resolves the version declared in a project's package manifest.
 *
 * @param {string} projectRoot The project root path.
 * @returns {string} Returns the version or an empty string.
 */
export function resolveProjectVersion (projectRoot) {
  const version = readPackageField(projectRoot, 'version')

  return typeof version === 'string' ? version : ''
}

/**
 * Resolves the package name declared by a project manifest.
 *
 * @param {string} projectRoot The project root path.
 * @returns {string} Returns the package name or an empty string.
 */
export function resolveProjectPackageName (projectRoot) {
  const name = readPackageField(projectRoot, 'name')

  return typeof name === 'string' ? name : ''
}

/**
 * Resolves npm scripts from a project's package manifest.
 *
 * @param {string} projectRoot The project root path.
 * @returns {Record<string, string>} Returns the project scripts.
 */
function resolveProjectScripts (projectRoot) {
  const scripts = readPackageField(projectRoot, 'scripts')

  return typeof scripts === 'object' && scripts !== null ? scripts : {}
}

/**
 * Resolves the build output directories declared by an Nx project.
 *
 * @param {Record<string, any>} project The project metadata.
 * @returns {string[]} Returns output directories relative to the project root.
 */
export function resolveBuildOutputDirectories (project) {
  const outputs = Array.isArray(project?.targets?.build?.outputs)
    ? project.targets.build.outputs
    : []
  const projectRootToken = '{projectRoot}/'

  return outputs
    .map(output => String(output || ''))
    .filter(Boolean)
    .map(output => output.startsWith(projectRootToken) ? output.slice(projectRootToken.length) : output)
    .map(output => output.replace(/^\//, ''))
    .filter(Boolean)
}

/**
 * Resolves the Nx target names declared by a project.
 *
 * @param {Record<string, any>} project The project metadata.
 * @returns {string[]} Returns target names.
 */
function resolveTargetNames (project) {
  if (!project || typeof project.targets !== 'object' || project.targets === null) {
    return []
  }

  return Object.keys(project.targets)
}

/**
 * Resolves the branch-aware React build plan for a frontend app.
 *
 * The resolved `distDirs` are best-effort hints; the packaging step zips
 * whichever configured outputs actually exist after the build.
 *
 * @param {string} branchName The effective branch name.
 * @param {Record<string, any>} project The project metadata.
 * @returns {{command: string, distDirs: string[]}} Returns the build plan.
 */
export function resolveReactBuildPlan (branchName, project) {
  const scripts = resolveProjectScripts(project.root)
  const outputDirectories = resolveBuildOutputDirectories(project)
  const hasScript = scriptName => typeof scripts[scriptName] === 'string'
  const filterOutputs = pattern => outputDirectories.filter(output => pattern.test(output))

  if ((branchName === 'master' || branchName === 'main') && hasScript('build:all')) {
    const distDirs = filterOutputs(/^dist-(dev|uat|prod)$/i)

    return { command: 'build:all', distDirs: distDirs.length > 0 ? distDirs : outputDirectories }
  }

  if (branchName === 'uat' && hasScript('build:uat')) {
    const distDirs = filterOutputs(/^dist-(dev|uat)$/i)

    return { command: 'build:uat', distDirs: distDirs.length > 0 ? distDirs : ['dist'] }
  }

  if ((branchName === 'dev' || branchName === 'development') && hasScript('build:dev')) {
    const distDirs = filterOutputs(/^dist-dev$/i)

    return { command: 'build:dev', distDirs: distDirs.length > 0 ? distDirs : ['dist'] }
  }

  return {
    command:  hasScript('build') ? 'build' : 'build:local',
    distDirs: outputDirectories.length > 0 ? outputDirectories : ['dist'],
  }
}

/**
 * Classifies a project into pipeline categories from its tags.
 *
 * @param {Record<string, any>} project The project metadata.
 * @returns {{ignored: boolean, tags: string[], type: Record<string, boolean>}} Returns classification data.
 */
export function classifyProject (project) {
  const tags = Array.isArray(project?.tags) ? project.tags.map(tag => String(tag)) : []
  const ignored = hasTagAlias(tags, PROJECT_TAG_ALIASES.ignore)

  return {
    ignored,
    tags,
    type: {
      externalPackage: !ignored && hasTagAlias(tags, PROJECT_TAG_ALIASES.externalPackages),
      functionApp:     !ignored && hasTagAlias(tags, PROJECT_TAG_ALIASES.functionApps),
      internalPackage: !ignored && hasTagAlias(tags, PROJECT_TAG_ALIASES.internalPackages),
      reactApp:        !ignored && hasTagAlias(tags, PROJECT_TAG_ALIASES.reactApps),
    },
  }
}

/**
 * Resolves a single human-readable label for a classified project.
 *
 * @param {Record<string, any>} project The enriched project data.
 * @returns {string} Returns the project category label.
 */
export function describeProjectType (project) {
  if (project.ignored) {
    return 'ignored'
  }

  if (project.type.functionApp) {
    return 'function-app'
  }

  if (project.type.reactApp) {
    return 'react-app'
  }

  if (project.type.externalPackage) {
    return 'publishable-lib'
  }

  if (project.type.internalPackage) {
    return 'internal-lib'
  }

  return 'unclassified'
}

/**
 * Resolves the pipeline action a project will trigger when affected.
 *
 * @param {Record<string, any>} project The enriched project data.
 * @returns {string} Returns the action label.
 */
export function describeProjectAction (project) {
  if (project.ignored) {
    return 'skip'
  }

  if (project.type.functionApp || project.type.reactApp) {
    return 'build + zip + drop'
  }

  if (project.type.externalPackage) {
    return 'publish (version from package.json)'
  }

  if (project.type.internalPackage) {
    return 'docs + vendored into apps'
  }

  return 'none'
}

/**
 * Enriches raw Nx metadata into the pipeline project model.
 *
 * @param {Record<string, any>} metadata The Nx project metadata.
 * @param {boolean} affected Whether the project is affected.
 * @param {string} branchName The effective branch name.
 * @returns {Record<string, any>} Returns the enriched project data.
 */
export function enrichProject (metadata, affected, branchName) {
  const classification = classifyProject(metadata)
  const root = typeof metadata.root === 'string' ? metadata.root : ''

  return {
    affected,
    buildOutputs: resolveBuildOutputDirectories(metadata),
    ignored:      classification.ignored,
    name:         typeof metadata.name === 'string' ? metadata.name : '',
    packageName:  root ? resolveProjectPackageName(root) : '',
    projectType:  typeof metadata.projectType === 'string' ? metadata.projectType : '',
    reactBuild:   classification.type.reactApp ? resolveReactBuildPlan(branchName, metadata) : null,
    root,
    sanitizedName: sanitizeVariableToken(metadata.name),
    tags:         classification.tags,
    targetNames:  resolveTargetNames(metadata),
    type:         classification.type,
    version:      root ? resolveProjectVersion(root) : '',
  }
}

/**
 * Builds the persisted context manifest from enriched projects.
 *
 * @param {{baseCommit: string, branchName: string, headCommit: string, projects: Array<Record<string, any>>}} input The manifest source data.
 * @returns {Record<string, any>} Returns the context manifest.
 */
export function buildContextManifest (input) {
  const { baseCommit, branchName, headCommit, projects } = input
  const active = projects.filter(project => !project.ignored)
  const affected = active.filter(project => project.affected)

  return {
    affectedProjects: affected.map(project => project.name),
    baseCommit,
    branchName,
    generatedAt: new Date().toISOString(),
    groups: {
      externalPackages: affected.filter(project => project.type.externalPackage).map(project => project.name),
      functionApps:     affected.filter(project => project.type.functionApp).map(project => project.name),
      ignoredProjects:  projects.filter(project => project.ignored).map(project => project.name),
      internalPackages: affected.filter(project => project.type.internalPackage).map(project => project.name),
      reactApps:        affected.filter(project => project.type.reactApp).map(project => project.name),
    },
    hasAffected: affected.length > 0,
    headCommit,
    projects,
  }
}

/**
 * Loads the persisted context manifest.
 *
 * @param {string} [contextPath] Optional explicit context file path.
 * @returns {Record<string, any>} Returns the parsed context manifest.
 */
export function loadContext (contextPath = process.env.MONOREPO_CONTEXT_FILE || CONTEXT_FILE_PATH) {
  return readJsonSafe(contextPath, {})
}

/**
 * Returns affected, non-ignored projects matching a category predicate.
 *
 * @param {Record<string, any>} context The context manifest.
 * @param {(project: Record<string, any>) => boolean} predicate The category predicate.
 * @returns {Array<Record<string, any>>} Returns the matching projects.
 */
export function selectAffected (context, predicate) {
  const projects = Array.isArray(context.projects) ? context.projects : []

  return projects
    .filter(project => project.affected && !project.ignored && predicate(project))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)))
}
