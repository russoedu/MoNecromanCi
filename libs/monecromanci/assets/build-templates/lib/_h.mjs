#!/usr/bin/env node

/**
 * Shared helpers for the reusable monorepo build templates.
 *
 * Every build step imports from this module so logging, command execution and
 * Azure DevOps integration behave identically across the pipeline. Commands are
 * executed through the platform shell using full command strings, which avoids
 * the Windows `.cmd` spawning quirks that affect `execFile` with argument arrays.
 */

import { execSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

/**
 * Returns whether the host platform is Windows.
 *
 * @returns {boolean} Returns true when running on Windows.
 */
export function isWindows () {
  return process.platform === 'win32'
}

/**
 * Returns whether the script is running inside an Azure DevOps pipeline.
 *
 * @returns {boolean} Returns true when the Azure agent variables are present.
 */
export function isAzure () {
  return String(process.env.TF_BUILD || '').toLowerCase() === 'true'
}

/**
 * Returns whether the script is running inside a GitHub Actions workflow.
 *
 * @returns {boolean} Returns true when the GitHub Actions variables are present.
 */
export function isGitHub () {
  return String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true'
}

/**
 * Appends a line to the file named by a GitHub Actions environment variable.
 *
 * @param {string} environmentName The env var holding the target file path (e.g. GITHUB_ENV).
 * @param {string} line The line to append (a trailing newline is added).
 */
function appendGitHubLine (environmentName, line) {
  const filePath = process.env[environmentName]
  if (filePath) {
    appendFileSync(filePath, `${line}\n`)
  }
}

/**
 * Logs an informational message.
 *
 * @param {string} message The message to log.
 */
export function log (message) {
  console.log(message)
}

/**
 * Logs a warning message.
 *
 * @param {string} message The message to log.
 */
export function warn (message) {
  console.warn(`[warning] ${message}`)
}

/**
 * Logs an error message.
 *
 * @param {string} message The message to log.
 */
export function error (message) {
  console.error(`[error] ${message}`)
}

/**
 * Logs a prominent banner used to separate pipeline phases.
 *
 * @param {string} message The banner text.
 */
export function banner (message) {
  const line = '='.repeat(72)

  console.log(`\n${line}\n  ${message}\n${line}`)
}

/**
 * Logs a sub-section heading within a phase.
 *
 * @param {string} message The section text.
 */
export function section (message) {
  console.log(`\n--- ${message} ---`)
}

/**
 * Logs an object array as a console table.
 *
 * @param {unknown} data The tabular data to render.
 */
export function table (data) {
  console.table(data)
}

/**
 * Escapes a value for safe interpolation into a shell command string.
 *
 * @param {string} value The raw value to escape.
 * @returns {string} Returns the quoted, shell-safe value.
 */
export function shellEscape (value) {
  const stringValue = String(value ?? '')

  if (isWindows()) {
    return `"${stringValue.replaceAll('"', '""')}"`
  }

  return `'${stringValue.replaceAll("'", "'\\''")}'`
}

/**
 * Executes a command string and returns trimmed stdout.
 *
 * @param {string} command The full command line to execute.
 * @param {import('node:child_process').ExecSyncOptions} [options] Optional exec options.
 * @returns {string} Returns trimmed command output.
 */
export function run (command, options = {}) {
  const output = execSync(command, {
    encoding: 'utf8',
    stdio:    ['ignore', 'pipe', 'pipe'],
    ...options,
  })

  return output == null ? '' : output.toString().trim()
}

/**
 * Executes a command string, returning an empty string on failure.
 *
 * @param {string} command The full command line to execute.
 * @param {import('node:child_process').ExecSyncOptions} [options] Optional exec options.
 * @returns {string} Returns trimmed output or an empty string.
 */
export function runSafe (command, options = {}) {
  try {
    return run(command, options)
  } catch (caughtError) {
    const stderr = caughtError?.stderr ? String(caughtError.stderr).trim() : ''
    const status = caughtError?.status ?? 'unknown'
    warn(`Command failed (exit ${status}): ${command}`)

    if (stderr) {
      warn(`stderr: ${stderr}`)
    }

    return ''
  }
}

/**
 * Executes a command string while inheriting stdio so output streams live.
 *
 * @param {string} command The full command line to execute.
 * @param {import('node:child_process').ExecSyncOptions} [options] Optional exec options.
 */
export function runInherit (command, options = {}) {
  log(`$ ${command}`)
  execSync(command, {
    stdio: 'inherit',
    ...options,
  })
}

/**
 * Reads and parses a JSON file from disk.
 *
 * @param {string} filePath The JSON file path.
 * @returns {Record<string, any>} Returns parsed content.
 */
export function readJson (filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

/**
 * Reads and parses a JSON file, returning a fallback on any failure.
 *
 * @param {string} filePath The JSON file path.
 * @param {Record<string, any>} [fallback] The fallback value.
 * @returns {Record<string, any>} Returns parsed content or the fallback.
 */
export function readJsonSafe (filePath, fallback = {}) {
  if (!existsSync(filePath)) {
    return fallback
  }

  try {
    return readJson(filePath)
  } catch {
    return fallback
  }
}

/**
 * Writes JSON content with stable two-space formatting and a trailing newline.
 *
 * @remarks
 * Creates the destination's parent directory if needed — `.build-templates/`
 * (the context file's usual home) is no longer vendored into the repo, so it
 * won't already exist as a real scratch directory.
 *
 * @param {string} filePath The destination file path.
 * @param {unknown} content The serialisable content.
 */
export function writeJson (filePath, content) {
  const directory = dirname(filePath)
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true })
  }
  writeFileSync(filePath, `${JSON.stringify(content, null, 2)}\n`, 'utf8')
}

/**
 * Emits an Azure DevOps pipeline variable, available to later steps.
 *
 * @param {string} name The variable name.
 * @param {string | number | boolean} value The variable value.
 */
export function setVariable (name, value) {
  const stringValue = String(value ?? '')

  if (isGitHub()) {
    // Persist to later steps in the same job; mirrors Azure's setvariable.
    appendGitHubLine('GITHUB_ENV', `${name}=${stringValue}`)
  } else {
    process.stdout.write(`##vso[task.setvariable variable=${name}]${stringValue}\n`)
  }

  process.env[name] = stringValue
}

/**
 * Emits multiple Azure DevOps pipeline variables and logs them as a table.
 *
 * @param {{name: string, value: string}[]} variables The variables to emit.
 */
export function setVariables (variables) {
  table(variables.map(variable => ({ name: variable.name, value: variable.value })))

  for (const variable of variables) {
    setVariable(variable.name, variable.value)
  }
}

/**
 * Sets the Azure DevOps build number.
 *
 * @param {string} buildNumber The build number to set.
 */
export function setBuildNumber (buildNumber) {
  if (isGitHub()) {
    appendGitHubLine('GITHUB_OUTPUT', `build-number=${buildNumber}`)
    return
  }

  process.stdout.write(`##vso[build.updatebuildnumber]${buildNumber}\n`)
}

/**
 * Adds a build tag to the current Azure DevOps run.
 *
 * @param {string} tag The build tag to add.
 */
export function addBuildTag (tag) {
  if (isGitHub()) {
    // No build-tag concept on GitHub; surface as an annotation + a step output a
    // downstream deploy job/workflow can react to. Drops are the real handoff.
    process.stdout.write(`::notice title=build-tag::${tag}\n`)
    appendGitHubLine('GITHUB_OUTPUT', `build-tag-${tag.replaceAll(/[^a-zA-Z0-9_-]+/g, '-')}=true`)
    return
  }

  process.stdout.write(`##vso[build.addbuildtag]${tag}\n`)
}

/**
 * Uploads a markdown file as the build summary in Azure DevOps.
 *
 * @param {string} summaryPath The summary file path.
 */
export function uploadSummary (summaryPath) {
  if (isGitHub()) {
    const stepSummary = process.env.GITHUB_STEP_SUMMARY
    if (stepSummary && existsSync(summaryPath)) {
      appendFileSync(stepSummary, `${readFileSync(summaryPath, 'utf8')}\n`)
    }
    return
  }

  process.stdout.write(`##vso[task.uploadsummary]${summaryPath}\n`)
}
