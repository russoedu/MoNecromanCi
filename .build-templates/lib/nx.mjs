#!/usr/bin/env node

/**
 * Nx and git helpers used to resolve the affected project set.
 *
 * Nx is always invoked through the locally installed binary
 * (`node_modules/.bin/nx`) so the workspace's pinned Nx version computes the
 * project graph. `npx --yes` is intentionally avoided because it can download a
 * different Nx version and produces an unreliable graph when run before install.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { isWindows, log, run, runInherit, runSafe, shellEscape, warn } from './_h.mjs'

const WORKSPACE_ROOT = process.cwd()

/**
 * Resolves the locally installed Nx binary path.
 *
 * @returns {string | null} Returns the Nx binary path, or null when missing.
 */
export function resolveLocalNxBin () {
  const binaryName = isWindows() ? 'nx.cmd' : 'nx'
  const binaryPath = path.join(WORKSPACE_ROOT, 'node_modules', '.bin', binaryName)

  return existsSync(binaryPath) ? binaryPath : null
}

/**
 * Builds the Nx command prefix, preferring the local binary.
 *
 * @returns {string} Returns the Nx invocation prefix.
 */
function getNxCommandPrefix () {
  const localBin = resolveLocalNxBin()

  if (localBin) {
    return shellEscape(localBin)
  }

  warn('Local Nx binary not found in node_modules/.bin. Falling back to "npx nx". Run "npm ci" first for reliable results.')

  return 'npx nx'
}

/**
 * Runs an Nx command and returns trimmed stdout.
 *
 * @param {string} args The Nx command arguments.
 * @returns {string} Returns trimmed command output.
 */
export function runNx (args) {
  return run(`${getNxCommandPrefix()} ${args}`, { cwd: WORKSPACE_ROOT })
}

/**
 * Runs an Nx command, returning an empty string on failure.
 *
 * @param {string} args The Nx command arguments.
 * @returns {string} Returns trimmed output or an empty string.
 */
export function runNxSafe (args) {
  return runSafe(`${getNxCommandPrefix()} ${args}`, { cwd: WORKSPACE_ROOT })
}

/**
 * Runs an Nx command while streaming output live (used for builds).
 *
 * @param {string} args The Nx command arguments.
 */
export function runNxInherit (args) {
  runInherit(`${getNxCommandPrefix()} ${args}`, { cwd: WORKSPACE_ROOT })
}

/**
 * Parses an Nx project list from raw command output.
 *
 * Tolerates the Nx banner/warning text that can precede the JSON array, and
 * falls back to line parsing when JSON is unavailable.
 *
 * @param {string} output The raw command output.
 * @returns {string[]} Returns parsed project names.
 */
export function parseProjectList (output) {
  if (!output) {
    return []
  }

  const trimmed = output.trim()

  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      return parsed.map(String)
    }
  } catch {
    // Falls through — Nx may have prepended banner text before the JSON array.
  }

  const jsonMatch = trimmed.match(/\[[\s\S]*\]/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      if (Array.isArray(parsed)) {
        return parsed.map(String)
      }
    } catch {
      // Falls through to line parsing.
    }
  }

  return trimmed
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith('>'))
    .filter(line => /^[\w-]/.test(line))
}

/**
 * Resolves all Nx project names in the workspace.
 *
 * @returns {string[]} Returns all project names.
 */
export function resolveAllProjects () {
  const jsonProjects = parseProjectList(runNxSafe('show projects --json'))
  if (jsonProjects.length > 0) {
    return jsonProjects
  }

  return parseProjectList(runNxSafe('show projects'))
}

/**
 * Resolves the affected Nx project names between two commits.
 *
 * @param {string} baseCommit The base commit SHA.
 * @param {string} headCommit The head commit SHA.
 * @returns {string[]} Returns affected project names.
 */
export function resolveAffectedProjects (baseCommit, headCommit) {
  const range = `--base=${shellEscape(baseCommit)} --head=${shellEscape(headCommit)}`

  const jsonOutput = runNxSafe(`show projects --affected ${range} --json`)
  const jsonProjects = parseProjectList(jsonOutput)
  if (jsonProjects.length > 0) {
    return jsonProjects
  }

  log('[affected] JSON output empty — retrying without --json')

  return parseProjectList(runNxSafe(`show projects --affected ${range}`))
}

/**
 * Resolves Nx metadata for a single project.
 *
 * @param {string} projectName The Nx project name.
 * @returns {Record<string, any> | null} Returns project metadata or null.
 */
export function resolveProjectMetadata (projectName) {
  const output = runNxSafe(`show project ${shellEscape(projectName)} --json`)
  if (!output) {
    return null
  }

  try {
    return JSON.parse(output)
  } catch {
    return null
  }
}

/**
 * Extracts a branch name from an Azure ref string.
 *
 * @param {string | undefined} reference The branch reference.
 * @returns {string} Returns the branch name.
 */
export function getBranchNameFromRef (reference) {
  if (!reference) {
    return ''
  }

  return reference.replace(/^refs\/heads\//, '')
}

/**
 * Resolves the effective branch name used for build planning.
 *
 * @returns {string} Returns the effective branch name.
 */
export function resolveEffectiveBranchName () {
  const isPullRequest = String(process.env.BUILD_REASON).toLowerCase() === 'pullrequest'

  if (isPullRequest) {
    return getBranchNameFromRef(process.env.SYSTEM_PULLREQUEST_TARGETBRANCH)
  }

  return process.env.BUILD_SOURCEBRANCHNAME || runSafe('git rev-parse --abbrev-ref HEAD')
}

/**
 * Resolves the current HEAD commit used by Nx affected.
 *
 * @returns {string} Returns the HEAD commit SHA.
 */
export function resolveHeadCommit () {
  return process.env.BUILD_SOURCEVERSION || run('git rev-parse HEAD')
}

/**
 * Resolves the base commit used by Nx affected.
 *
 * Uses `~1` rather than `^` so the command never contains a caret, which the
 * Windows command shell treats as an escape character.
 *
 * @param {string} headCommit The resolved head commit SHA.
 * @returns {string} Returns the base commit SHA.
 */
export function resolveBaseCommit (headCommit) {
  const isPullRequest = String(process.env.BUILD_REASON).toLowerCase() === 'pullrequest'
  log(`[base] BUILD_REASON=${process.env.BUILD_REASON || '(none)'}, isPR=${isPullRequest}`)

  if (isPullRequest) {
    const targetBranchName = getBranchNameFromRef(process.env.SYSTEM_PULLREQUEST_TARGETBRANCH)
    const remoteBranch = targetBranchName ? `origin/${targetBranchName}` : ''
    log(`[base] PR target branch: ${remoteBranch || '(unknown)'}`)

    const mergeBase = remoteBranch
      ? runSafe(`git merge-base ${shellEscape(headCommit)} ${shellEscape(remoteBranch)}`)
      : ''

    if (mergeBase) {
      log(`[base] Resolved via merge-base: ${mergeBase}`)
      return mergeBase
    }

    warn('[base] merge-base failed — falling back to parent commit')
  }

  const parentCommit = runSafe(`git rev-parse ${shellEscape(`${headCommit}~1`)}`)
  if (parentCommit && parentCommit !== headCommit) {
    log(`[base] Resolved via parent commit: ${parentCommit}`)
    return parentCommit
  }

  const initialCommit = runSafe(`git rev-list --max-parents=0 ${shellEscape(headCommit)}`).split('\n')[0]
  log(`[base] Resolved via initial commit: ${initialCommit || '(none)'}`)

  return initialCommit
}
