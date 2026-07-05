#!/usr/bin/env node

/**
 * Step 04 — Publish libraries.
 *
 * Versions are managed manually: a developer sets the `version` in each
 * library's `package.json`. This step publishes every affected
 * `type:publishable-lib` at the version already declared on disk, skipping any
 * version already present on the registry. It does not bump versions, create
 * tags, or push commits.
 *
 * What ships is the built `dist/` folder only (transpiled `*.js` + `*.d.ts` +
 * source maps and the generated `dist/package.json`), never the source tree —
 * the project's build emits `dist/` and `tools/generate-dist-package.mjs` writes
 * its clean, publishable manifest.
 *
 * Gated by the YAML step to non-PR builds on a release branch (master/main).
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  banner,
  isWindows,
  log,
  readJsonSafe,
  run,
  runInherit,
  runSafe,
  section,
  setVariable,
  shellEscape,
  warn,
} from './lib/_h.mjs'
import { loadContext, selectAffected } from './lib/context.mjs'
import { runNxInherit } from './lib/nx.mjs'

const WORKSPACE_ROOT = process.cwd()
const NPM_BIN = isWindows() ? 'npm.cmd' : 'npm'
const NPM_USER_CONFIG = path.join(WORKSPACE_ROOT, '.npmrc')

/**
 * Returns whether the current build is a pull request validation.
 *
 * @returns {boolean} Returns true for pull request builds.
 */
function isPullRequest () {
  return String(process.env.BUILD_REASON || '').toLowerCase() === 'pullrequest'
}

/**
 * Returns whether the current branch is allowed to publish.
 *
 * The allowed branches default to `master` and `main` and can be overridden with
 * the `RELEASE_BRANCHES` environment variable (comma-separated).
 *
 * @returns {boolean} Returns true when the current branch may publish.
 */
function isReleaseBranch () {
  const allowed = (process.env.RELEASE_BRANCHES || 'master,main')
    .split(',')
    .map(branch => branch.trim().toLowerCase())
    .filter(Boolean)
  const current = String(process.env.BUILD_SOURCEBRANCHNAME || runSafe('git rev-parse --abbrev-ref HEAD')).trim().toLowerCase()

  return allowed.includes(current)
}

/**
 * Resolves whether a package version is already on the registry.
 *
 * @param {string} packageName The package name.
 * @param {string} packageVersion The package version.
 * @returns {boolean} Returns true when the version already exists.
 */
function isVersionPublished (packageName, packageVersion) {
  try {
    const output = run(`${NPM_BIN} view ${shellEscape(`${packageName}@${packageVersion}`)} version --json --userconfig ${shellEscape(NPM_USER_CONFIG)}`)

    return JSON.parse(output) === packageVersion
  } catch {
    return false
  }
}

/**
 * Publishes a single library at its declared version and records the outcome.
 *
 * @param {Record<string, any>} project The library project data.
 * @param {{published: string[], skipped: string[]}} results The publish result accumulator.
 */
function publishLibrary (project, results) {
  const projectRoot = path.join(WORKSPACE_ROOT, project.root)
  const packageJson = readJsonSafe(path.join(projectRoot, 'package.json'))
  const packageName = String(packageJson.name || '').trim()
  const packageVersion = String(packageJson.version || '').trim()

  if (packageJson.private === true) {
    log(`[${project.name}] skipped — package is private`)
    return
  }

  if (!packageName || !packageVersion) {
    log(`[${project.name}] skipped — missing package name or version in package.json`)
    return
  }

  if (isVersionPublished(packageName, packageVersion)) {
    log(`[${project.name}] skipped — ${packageName}@${packageVersion} already published`)
    results.skipped.push(`${packageName}@${packageVersion}`)
    return
  }

  log(`[${project.name}] building before publish`)
  runNxInherit(`run ${project.name}:build`)

  // Publish the built dist/ folder, not the project root: the source tree carries
  // no `files` allow-list, so publishing from projectRoot would ship the raw
  // `*.ts`, tests and configs instead of the compiled output.
  const distDir = path.join(projectRoot, 'dist')
  if (!existsSync(distDir)) {
    throw new Error(`[${project.name}] build produced no dist/ at ${distDir} — cannot publish`)
  }

  log(`[${project.name}] publishing ${packageName}@${packageVersion} from dist/`)
  runInherit(`${NPM_BIN} publish ${shellEscape(distDir)} --userconfig ${shellEscape(NPM_USER_CONFIG)}`, { cwd: projectRoot })
  results.published.push(`${packageName}@${packageVersion}`)
}

/**
 * Runs the manual-version publish workflow.
 */
function main () {
  banner('[04] Publish libraries (versions managed manually in package.json)')

  const context = loadContext()
  const publishableLibraries = selectAffected(context, project => project.type.externalPackage)

  if (publishableLibraries.length === 0) {
    banner('[04] No affected publishable libraries — nothing to publish')
    return
  }

  if (isPullRequest()) {
    warn('Pull request build — skipping publish (validation only).')
    return
  }

  if (!isReleaseBranch()) {
    warn(`Branch "${process.env.BUILD_SOURCEBRANCHNAME || '(unknown)'}" is not a publish branch (${process.env.RELEASE_BRANCHES || 'master,main'}) — skipping publish.`)
    return
  }

  log(`Candidates (${publishableLibraries.length}): ${publishableLibraries.map(project => project.name).join(', ')}`)

  const results = { published: [], skipped: [] }
  for (const project of publishableLibraries) {
    section(`Publish: ${project.name}`)
    publishLibrary(project, results)
  }

  setVariable('PUBLISHED_LIBS', results.published.join(', '))
  setVariable('SKIPPED_LIBS', results.skipped.join(', '))

  banner(`[04] Publish complete — published ${results.published.length}, skipped ${results.skipped.length}`)
}

main()
