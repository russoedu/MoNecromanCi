#!/usr/bin/env node

/**
 * Step 04 — Publish libraries.
 *
 * Versions are decided automatically: `nx release version` reads the
 * Conventional Commit messages since each affected publishable project's last
 * release tag, computes the bump (patch/minor/major), writes the new version
 * (and changelog) to disk, then commits, tags (`{project}@{version}`) and
 * pushes the result back to the release branch — before anything is built or
 * published. A project with no releasable commits since its last tag is left
 * untouched. A project with no matching tag yet (never released) falls back to
 * whatever version is on disk (see `release.version.fallbackCurrentVersionResolver`
 * in `nx.json`), so a brand-new project needs no manual bootstrapping.
 *
 * What ships is the built `dist/` folder (transpiled `*.js` + `*.d.ts` + source
 * maps and the generated `dist/package.json`) whenever the build emits that
 * manifest — the publishable-lib convention, via `tools/generate-dist-package.mjs`.
 * A project that packages itself from its root through a `files` allow-list (e.g.
 * a bundled CLI) is published from its root instead. A root with neither a
 * `dist/package.json` nor a `files` list is refused, never shipped raw.
 *
 * Before publishing, the target manifest is checked for a `publish`/`postpublish`/
 * `prepublish` script — npm runs these as lifecycle hooks right after the upload,
 * and a stale or mismatched one can fail the whole command even though the package
 * already reached the registry. Caught up front instead of surfacing as a cryptic
 * post-upload failure.
 *
 * Gated by the YAML step to non-PR builds on a release branch (master/main).
 * Pushing the version-bump commit/tags needs write access back to the repo — see
 * `docs/nx-release.md` for the permission each CI provider needs.
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
 * Sets a local (repo-scoped) git identity so `nx release version` can commit,
 * only if one isn't already configured (never touches the machine's global config).
 */
function ensureGitIdentity () {
  if (!runSafe('git config user.email')) {
    run('git config user.email "monecromanci-ci@users.noreply.github.com"')
    run('git config user.name "MoNecromanCI CI"')
  }
}

/**
 * Bumps, tags and pushes the affected publishable projects from their
 * Conventional Commit history since each one's last release tag.
 *
 * @param {Record<string, any>[]} publishableLibraries The affected publishable projects.
 */
function bumpVersions (publishableLibraries) {
  ensureGitIdentity()

  const projects = publishableLibraries.map(project => project.name).join(',')
  section('Version (nx release)')
  runInherit(`npx nx release version --projects=${shellEscape(projects)} --git-commit --git-commit-message ${shellEscape('chore(release): publish')} --git-tag --git-push --verbose`)
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

  // Choose what to publish:
  //  • dist/ when the build emitted its own dist/package.json — the MoNecromanCI
  //    publishable-lib convention (compiled *.js + *.d.ts + maps + clean manifest).
  //  • otherwise the project root, but ONLY if package.json has a `files`
  //    allow-list (e.g. a bundled CLI that packages `dist` itself). Publishing a
  //    root with no allow-list would ship the raw *.ts sources, tests and configs.
  const distDir = path.join(projectRoot, 'dist')
  const hasDistManifest = existsSync(path.join(distDir, 'package.json'))
  const publishTarget = hasDistManifest ? distDir : projectRoot

  if (!hasDistManifest && !Array.isArray(packageJson.files)) {
    throw new Error(`[${project.name}] no dist/package.json and no "files" allow-list in package.json — refusing to publish the raw source tree`)
  }

  // npm treats a script literally named "publish" (or "postpublish"/"prepublish") as
  // a publish lifecycle hook: it re-invokes that script right after the tarball is
  // uploaded, using THIS manifest's scripts. If the target manifest carries one and
  // it doesn't hold up on its own (e.g. it points at a dist/ with no package.json),
  // the whole `npm publish` command fails even though the upload already succeeded.
  // Catch this before touching the registry rather than after a half-successful publish.
  const publishManifest = hasDistManifest ? readJsonSafe(path.join(distDir, 'package.json')) : packageJson
  const lifecycleHookNames = ['prepublish', 'publish', 'postpublish']
  const collidingHook = lifecycleHookNames.find(name => typeof publishManifest.scripts?.[name] === 'string')
  if (collidingHook) {
    throw new Error(`[${project.name}] the manifest being published has a "${collidingHook}" script — npm runs this automatically as a publish lifecycle hook, which can recurse or fail unexpectedly. Rename or remove it.`)
  }

  log(`[${project.name}] publishing ${packageName}@${packageVersion} from ${hasDistManifest ? 'dist/' : 'project root (files allow-list)'}`)
  runInherit(`${NPM_BIN} publish ${shellEscape(publishTarget)} --userconfig ${shellEscape(NPM_USER_CONFIG)}`, { cwd: projectRoot })
  results.published.push(`${packageName}@${packageVersion}`)
}

/**
 * Runs the version-then-publish workflow.
 */
function main () {
  banner('[04] Publish libraries (versioned from conventional commits)')

  const context = loadContext()
  const publishableLibraries = selectAffected(context, project => project.type.externalPackage)

  if (publishableLibraries.length === 0) {
    banner('[04] No affected publishable libraries — nothing to publish')
    return
  }

  if (isPullRequest()) {
    warn('Pull request build — skipping version bump and publish (validation only).')
    return
  }

  if (!isReleaseBranch()) {
    warn(`Branch "${process.env.BUILD_SOURCEBRANCHNAME || '(unknown)'}" is not a publish branch (${process.env.RELEASE_BRANCHES || 'master,main'}) — skipping version bump and publish.`)
    return
  }

  log(`Candidates (${publishableLibraries.length}): ${publishableLibraries.map(project => project.name).join(', ')}`)

  bumpVersions(publishableLibraries)

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
