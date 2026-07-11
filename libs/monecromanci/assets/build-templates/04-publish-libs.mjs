#!/usr/bin/env node

/**
 * Step 04 — Publish libraries.
 *
 * Versions are decided automatically: `nx release version` reads the
 * Conventional Commit messages since each affected publishable project's last
 * release tag, computes the bump (patch/minor/major), writes the new version
 * (and changelog) to disk, then tags (`{project}@{version}`) and pushes only
 * the tag — never a commit — before anything is built or published. Both
 * GitHub and Azure DevOps repos commonly protect the release branch against
 * direct pushes, which rejects the atomic commit+tag push nx would otherwise
 * attempt; `nx release` resolves each project's version from the tag name
 * regardless, so nothing is lost by never committing the bump. A project with
 * no releasable commits since its last tag is left untouched. A project with
 * no matching tag yet (never released) falls back to whatever version is on
 * disk (see `release.version.fallbackCurrentVersionResolver` in `nx.json`),
 * so a brand-new project needs no manual bootstrapping.
 *
 * Publishing itself is delegated to `nx release publish`, which builds each
 * project first (the `nx-release-publish` target's `dependsOn: ['build']` in
 * `nx.json`), resolves what to publish from its `packageRoot` option
 * (`dist/{projectRoot}` by default — the publishable-lib convention, via
 * `tools/generate-dist-package.mjs`; a root-published project, e.g. a bundled
 * CLI with a `files` allow-list, overrides `packageRoot` to `.` in its own
 * `project.json`), and skips anything already on the registry.
 *
 * Before that, every candidate's manifest is checked for a `publish`/
 * `postpublish`/`prepublish` script — npm runs these as lifecycle hooks right
 * after the upload, and a stale or mismatched one can fail the whole command
 * even though the package already reached the registry. Caught up front
 * instead of surfacing as a cryptic post-upload failure.
 *
 * Gated by the YAML step to non-PR builds on a release branch (master/main).
 * Pushing the version-bump commit/tags needs write access back to the repo — see
 * `docs/nx-release.md` for the permission each CI provider needs.
 */

import path from 'node:path'
import process from 'node:process'
import {
  banner,
  log,
  readJsonSafe,
  run,
  runInherit,
  runSafe,
  section,
  shellEscape,
  warn,
} from './lib/_h.mjs'
import { loadContext, selectAffected } from './lib/context.mjs'

const WORKSPACE_ROOT = process.cwd()

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
  // No commit: both GitHub and Azure DevOps repos commonly protect the release
  // branch against direct pushes, which rejects the atomic commit+tag push
  // (confirmed on both providers). Only the tag is pushed; nx resolves each
  // project's version from the tag name, so nothing is lost by not committing.
  runInherit(`npx nx release version --projects=${shellEscape(projects)} --no-git-commit --git-tag --git-push --verbose`)
}

/**
 * Throws if any candidate's own manifest carries a `publish`/`prepublish`/
 * `postpublish` script. npm runs these automatically as publish lifecycle
 * hooks right after the upload; a stale or mismatched one can fail the whole
 * command even though the package already reached the registry. Checked
 * before touching the registry at all, rather than after a half-successful
 * publish.
 *
 * @param {Record<string, any>[]} publishableLibraries The candidate projects.
 */
function guardAgainstPublishLifecycleHooks (publishableLibraries) {
  const lifecycleHookNames = ['prepublish', 'publish', 'postpublish']

  for (const project of publishableLibraries) {
    const packageJson = readJsonSafe(path.join(WORKSPACE_ROOT, project.root, 'package.json'))
    const collidingHook = lifecycleHookNames.find(name => typeof packageJson.scripts?.[name] === 'string')

    if (collidingHook) {
      throw new Error(`[${project.name}] package.json has a "${collidingHook}" script — npm runs this automatically as a publish lifecycle hook, which can recurse or fail unexpectedly. Rename or remove it.`)
    }
  }
}

/**
 * Publishes the affected publishable projects via `nx release publish`,
 * which builds each one first, resolves the manifest to publish from its
 * `nx-release-publish` target's `packageRoot`, and skips anything already on
 * the registry.
 *
 * @param {Record<string, any>[]} publishableLibraries The affected publishable projects.
 */
function publishLibraries (publishableLibraries) {
  const projects = publishableLibraries.map(project => project.name).join(',')
  section('Publish (nx release publish)')
  runInherit(`npx nx release publish --projects=${shellEscape(projects)} --verbose`)
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

  guardAgainstPublishLifecycleHooks(publishableLibraries)
  bumpVersions(publishableLibraries)
  publishLibraries(publishableLibraries)

  banner('[04] Publish complete')
}

main()
