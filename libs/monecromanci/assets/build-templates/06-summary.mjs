#!/usr/bin/env node

/**
 * Step 06 — Build summary.
 *
 * Reads the context manifest plus the Jest/Cobertura reports left by the quality
 * control step and renders a markdown summary (pipeline context, package
 * versions, test/coverage results and build outputs) that is attached to the
 * Azure DevOps run. Always runs, even when earlier steps failed.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { banner, log, readJsonSafe, runSafe, shellEscape, uploadSummary } from './lib/_h.mjs'
import { loadContext } from './lib/context.mjs'

const ROOT_DIR = process.cwd()
const SUMMARY_FILE_NAME = 'summary.md'

/**
 * Escapes markdown table cell content.
 *
 * @param {string | number | boolean | undefined | null} value The cell value.
 * @returns {string} Returns the escaped value.
 */
function escapeCell (value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br/>')
}

/**
 * Safely reads a UTF-8 text file.
 *
 * @param {string} filePath The file path.
 * @returns {string} Returns the file content or an empty string.
 */
function readTextSafe (filePath) {
  if (!existsSync(filePath)) {
    return ''
  }

  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Parses a numeric value from a string safely.
 *
 * @param {string | undefined} value The value to parse.
 * @returns {number | null} Returns the parsed number or null.
 */
function toNumber (value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }

  const parsed = Number(value)

  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Extracts attributes from the first matching XML tag.
 *
 * @param {string} xml The XML source.
 * @param {string} tagName The tag name.
 * @returns {Record<string, string>} Returns the attributes map.
 */
function parseXmlAttributes (xml, tagName) {
  const tagMatch = xml.match(new RegExp(`<${tagName}\\s+([^>]+)>`, 'i'))
  if (!tagMatch) {
    return {}
  }

  const attributes = {}
  const attributeRegex = /(\w[\w-]*)="([^"]*)"/g
  let match = attributeRegex.exec(tagMatch[1])

  while (match) {
    attributes[match[1]] = match[2]
    match = attributeRegex.exec(tagMatch[1])
  }

  return attributes
}

/**
 * Parses a Jest JUnit report summary.
 *
 * @param {string} reportPath The report path.
 * @returns {{tests: number, failures: number, errors: number, time: number, exists: boolean}} Returns the parsed summary.
 */
function readJunitSummary (reportPath) {
  const xml = readTextSafe(reportPath)
  if (!xml) {
    return { tests: 0, failures: 0, errors: 0, time: 0, exists: false }
  }

  const attributes = parseXmlAttributes(xml, 'testsuites')

  return {
    tests:    toNumber(attributes.tests) || 0,
    failures: toNumber(attributes.failures) || 0,
    errors:   toNumber(attributes.errors) || 0,
    time:     toNumber(attributes.time) || 0,
    exists:   true,
  }
}

/**
 * Parses a Cobertura coverage report summary.
 *
 * @param {string} reportPath The report path.
 * @returns {{lineRate: number | null, branchRate: number | null, linesCovered: number, linesValid: number, exists: boolean}} Returns the parsed summary.
 */
function readCoverageSummary (reportPath) {
  const xml = readTextSafe(reportPath)
  if (!xml) {
    return { lineRate: null, branchRate: null, linesCovered: 0, linesValid: 0, exists: false }
  }

  const attributes = parseXmlAttributes(xml, 'coverage')

  return {
    branchRate:   attributes['branch-rate'] ? toNumber(attributes['branch-rate']) : null,
    exists:       true,
    lineRate:     attributes['line-rate'] ? toNumber(attributes['line-rate']) : null,
    linesCovered: toNumber(attributes['lines-covered']) || 0,
    linesValid:   toNumber(attributes['lines-valid']) || 0,
  }
}

/**
 * Formats a duration in seconds.
 *
 * @param {number} seconds The duration in seconds.
 * @returns {string} Returns the formatted duration.
 */
function formatSeconds (seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 'n/a'
  }

  if (seconds < 60) {
    return `${seconds.toFixed(2)}s`
  }

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = (seconds - (minutes * 60)).toFixed(2).padStart(5, '0')

  return `${minutes}m ${remainingSeconds}s`
}

/**
 * Formats a coverage percentage from a decimal rate.
 *
 * @param {number | null} rate The decimal rate.
 * @returns {string} Returns the formatted percentage.
 */
function formatRate (rate) {
  if (rate === null || !Number.isFinite(rate)) {
    return 'n/a'
  }

  return `${(rate * 100).toFixed(2)}%`
}

/**
 * Renders an ASCII progress bar for a decimal rate.
 *
 * @param {number | null} rate The decimal rate.
 * @returns {string} Returns the bar string.
 */
function formatRateBar (rate) {
  if (rate === null || !Number.isFinite(rate)) {
    return 'n/a'
  }

  const totalBlocks = 12
  const filledBlocks = Math.round(Math.max(0, Math.min(1, rate)) * totalBlocks)

  return `[${'#'.repeat(filledBlocks)}${'-'.repeat(totalBlocks - filledBlocks)}]`
}

/**
 * Resolves the UTC modification timestamp for a path.
 *
 * @param {string} targetPath The file or directory path.
 * @returns {string} Returns the UTC timestamp or n/a.
 */
function getUtcLastWriteTime (targetPath) {
  if (!existsSync(targetPath)) {
    return 'n/a'
  }

  try {
    return statSync(targetPath).mtime.toISOString().replace('T', ' ').replace('Z', ' UTC')
  } catch {
    return 'n/a'
  }
}

/**
 * Creates markdown table lines.
 *
 * @param {string[]} headers The table headers.
 * @param {Array<Array<string | number | boolean>>} rows The table rows.
 * @returns {string[]} Returns the markdown table lines.
 */
function createTable (headers, rows) {
  const lines = [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ]

  for (const row of rows) {
    lines.push(`| ${row.map(escapeCell).join(' | ')} |`)
  }

  return lines
}

/**
 * Resolves the first parent ref for the current HEAD.
 *
 * @returns {string | null} Returns the previous commit ref or null.
 */
function getPreviousCommitRef () {
  return runSafe('git rev-parse HEAD~1') || null
}

/**
 * Reads JSON content from a git ref.
 *
 * @param {string} gitRef The git ref to read from.
 * @param {string} relativePath The workspace-relative file path.
 * @returns {Record<string, any> | null} Returns parsed JSON or null.
 */
function readJsonFromGitRef (gitRef, relativePath) {
  const content = runSafe(`git show ${shellEscape(`${gitRef}:${relativePath}`)}`)
  if (!content) {
    return null
  }

  try {
    return JSON.parse(content)
  } catch {
    return null
  }
}

/**
 * Formats a project version change against the previous commit.
 *
 * @param {string} projectRoot The workspace-relative project root.
 * @param {string} currentVersion The current package version.
 * @param {string | null} previousCommitRef The previous commit ref.
 * @returns {string} Returns the version transition or "not updated".
 */
function formatVersionChange (projectRoot, currentVersion, previousCommitRef) {
  if (!previousCommitRef) {
    return 'not updated'
  }

  const previousPackageJson = readJsonFromGitRef(previousCommitRef, `${projectRoot}/package.json`)
  const previousVersion = typeof previousPackageJson?.version === 'string' ? previousPackageJson.version : null

  if (!previousVersion || previousVersion === currentVersion) {
    return 'not updated'
  }

  return `${previousVersion} -> ${currentVersion}`
}

/**
 * Resolves the expected build outputs for a context project.
 *
 * @param {Record<string, any>} project The context project data.
 * @returns {string[]} Returns the output directories.
 */
function getBuildOutputs (project) {
  if (project.type?.reactApp && Array.isArray(project.reactBuild?.distDirs)) {
    return project.reactBuild.distDirs.map(output => `${project.root}/${output}`)
  }

  if (Array.isArray(project.buildOutputs)) {
    return project.buildOutputs.map(output => `${project.root}/${output}`)
  }

  return []
}

/**
 * Builds a test and coverage report for a context project.
 *
 * @param {Record<string, any>} project The context project data.
 * @param {string | null} previousCommitRef The previous commit ref.
 * @returns {Record<string, any>} Returns the merged workspace report.
 */
function createWorkspaceReport (project, previousCommitRef) {
  const projectRoot = String(project.root || '')
  const junit = readJunitSummary(path.join(ROOT_DIR, projectRoot, 'coverage', 'test-results.xml'))
  const coverage = readCoverageSummary(path.join(ROOT_DIR, projectRoot, 'coverage', 'cobertura-coverage.xml'))

  return {
    branchRate:    coverage.branchRate,
    errors:        junit.errors,
    failures:      junit.failures,
    hasCoverage:   coverage.exists,
    hasJunit:      junit.exists,
    lineRate:      coverage.lineRate,
    linesCovered:  coverage.linesCovered,
    linesValid:    coverage.linesValid,
    packageName:   String(project.packageName || project.name || 'n/a'),
    projectName:   String(project.name || 'unknown'),
    projectRoot,
    tests:         junit.tests,
    time:          junit.time,
    version:       String(project.version || 'n/a'),
    versionChange: formatVersionChange(projectRoot, String(project.version || 'n/a'), previousCommitRef),
  }
}

/**
 * Writes the markdown summary and emits the Azure upload command.
 *
 * @param {string[]} markdownLines The markdown lines.
 */
function publishSummary (markdownLines) {
  const summaryPath = path.join(ROOT_DIR, SUMMARY_FILE_NAME)
  writeFileSync(summaryPath, `${markdownLines.join('\n')}\n`, 'utf8')
  uploadSummary(summaryPath)
  log(`Summary generated: ${summaryPath}`)
}

/**
 * Runs the summary generator.
 */
function main () {
  banner('[06] Build summary')

  const now = new Date()
  const context = loadContext()
  const projects = (Array.isArray(context.projects) ? context.projects : []).filter(project => !project.ignored)
  const affectedProjects = new Set(Array.isArray(context.affectedProjects) ? context.affectedProjects : [])
  const previousCommitRef = getPreviousCommitRef()
  const workspaceDisplayName = String(readJsonSafe(path.join(ROOT_DIR, 'package.json')).name || 'Workspace')

  const reports = [...projects]
    .sort((left, right) => String(left.root).localeCompare(String(right.root)))
    .map(project => createWorkspaceReport(project, previousCommitRef))

  const totalTests = reports.reduce((sum, report) => sum + report.tests, 0)
  const totalFailures = reports.reduce((sum, report) => sum + report.failures, 0)
  const totalErrors = reports.reduce((sum, report) => sum + report.errors, 0)
  const totalTime = reports.reduce((sum, report) => sum + report.time, 0)
  const coveredLines = reports.reduce((sum, report) => sum + report.linesCovered, 0)
  const validLines = reports.reduce((sum, report) => sum + report.linesValid, 0)
  const globalLineRate = validLines > 0 ? coveredLines / validLines : null

  const pipelineContextRows = [
    ['Build reason', process.env.BUILD_REASON || 'n/a'],
    ['Branch', process.env.BUILD_SOURCEBRANCHNAME || context.branchName || 'n/a'],
    ['PR target', process.env.SYSTEM_PULLREQUEST_TARGETBRANCH || 'n/a'],
    ['Commit', process.env.BUILD_SOURCEVERSION || context.headCommit || 'n/a'],
    ['NX base', process.env.NX_BASE || context.baseCommit || 'n/a'],
    ['NX head', process.env.NX_HEAD || context.headCommit || 'n/a'],
    ['Affected projects', [...affectedProjects].join(',') || 'none'],
    ['Function apps', (context.groups?.functionApps || []).join(',') || 'none'],
    ['React apps', (context.groups?.reactApps || []).join(',') || 'none'],
    ['Internal packages', (context.groups?.internalPackages || []).join(',') || 'none'],
    ['External packages', (context.groups?.externalPackages || []).join(',') || 'none'],
    ['Generated at (UTC)', now.toISOString().replace('T', ' ').replace('Z', ' UTC')],
  ]

  const packageRows = reports.map(report => [
    report.projectName,
    report.packageName,
    report.version,
    report.versionChange,
    report.projectRoot,
  ])

  const qaRows = reports.map(report => {
    const status = (report.failures + report.errors) > 0
      ? 'FAILED'
      : (report.hasJunit ? 'PASSED' : 'NO REPORT')

    return [
      report.projectName,
      status,
      String(report.tests),
      String(report.failures),
      String(report.errors),
      formatSeconds(report.time),
      `${formatRate(report.lineRate)} ${formatRateBar(report.lineRate)}`,
      `${formatRate(report.branchRate)} ${formatRateBar(report.branchRate)}`,
      report.hasJunit ? 'yes' : 'no',
      report.hasCoverage ? 'yes' : 'no',
    ]
  })

  const buildRows = projects.map(project => {
    const outputPaths = getBuildOutputs(project)
    const existingOutputs = outputPaths.filter(outputPath => existsSync(path.join(ROOT_DIR, outputPath)))
    const latestOutputTime = outputPaths.length > 0
      ? outputPaths.map(outputPath => getUtcLastWriteTime(path.join(ROOT_DIR, outputPath))).find(timestamp => timestamp !== 'n/a') || 'n/a'
      : 'n/a'

    return [
      project.name,
      affectedProjects.has(project.name) ? 'yes' : 'no',
      outputPaths.length > 0 ? outputPaths.join('<br/>') : 'n/a',
      existingOutputs.length > 0 ? existingOutputs.join('<br/>') : 'none',
      latestOutputTime,
    ]
  })

  const markdownLines = [
    `# ${workspaceDisplayName} Build Summary`,
    '',
    '## Snapshot',
    '',
    `- Projects discovered: ${reports.length}`,
    `- Total tests: ${totalTests}`,
    `- Failures: ${totalFailures}`,
    `- Errors: ${totalErrors}`,
    `- Total test time: ${formatSeconds(totalTime)}`,
    `- Global line coverage: ${formatRate(globalLineRate)}    ${formatRateBar(globalLineRate)}`,
    '',
    '## Pipeline Context',
    '',
    ...createTable(['Key', 'Value'], pipelineContextRows),
    '',
    '## Workspace Packages',
    '',
    ...createTable(['Project', 'Package', 'Version', 'Version update', 'Path'], packageRows),
    '',
    '## Test and Coverage Results',
    '',
    ...createTable(
      ['Project', 'Result', 'Tests', 'Failures', 'Errors', 'Time', 'Line coverage', 'Branch coverage', 'JUnit', 'Cobertura'],
      qaRows,
    ),
    '',
    '## Build Outputs',
    '',
    ...createTable(
      ['Project', 'Expected to build', 'Configured outputs', 'Detected outputs', 'Last output update (UTC)'],
      buildRows,
    ),
  ]

  publishSummary(markdownLines)
  banner('[06] Build summary complete')
}

main()
