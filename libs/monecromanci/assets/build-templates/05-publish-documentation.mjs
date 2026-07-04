#!/usr/bin/env node

/**
 * Step 05 — Publish documentation.
 *
 * Uploads generated TypeDoc output for every affected library (internal or
 * publishable) to the documentation blob container. Each project is uploaded to
 * its own destination so projects never overwrite each other.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { banner, log, run, runInherit, section, shellEscape, warn } from './lib/_h.mjs'
import { loadContext, selectAffected } from './lib/context.mjs'
import { runNxInherit } from './lib/nx.mjs'

const WORKSPACE_ROOT = process.cwd()

/**
 * Resolves the base blob destination for documentation.
 *
 * @returns {string} Returns the base blob destination path.
 */
function getDocumentationDestination () {
  const buildDefinitionName = process.env.BUILD_DEFINITIONNAME || 'local'

  return `$web/${buildDefinitionName}`
}

/**
 * Ensures the Azure CLI is available before uploading.
 */
function ensureAzureCliAvailable () {
  run('az --version')
}

/**
 * Publishes generated documentation for affected library projects.
 */
function main () {
  banner('[05] Publish documentation')

  const context = loadContext()
  const documentationProjects = selectAffected(context, project => project.type.internalPackage || project.type.externalPackage)

  if (documentationProjects.length === 0) {
    banner('[05] No affected library documentation to publish')
    return
  }

  // Generate the docs for the affected range (no-ops for projects without a doc target).
  section('Generating documentation')
  const base = process.env.NX_BASE || ''
  const head = process.env.NX_HEAD || ''
  const range = base && head ? ` --base=${shellEscape(base)} --head=${shellEscape(head)}` : ''
  runNxInherit(`affected -t doc${range} --outputStyle=static`)

  const connectionString = process.env.saDevConnectionString
  if (!connectionString) {
    banner('[05] Documentation hosting not configured (saDevConnectionString unset) — skipping upload')
    return
  }

  ensureAzureCliAvailable()
  const destination = getDocumentationDestination()

  for (const project of documentationProjects) {
    section(`Documentation: ${project.name}`)

    const documentationPath = path.join(WORKSPACE_ROOT, project.root, 'doc')
    const markerPath = path.join(documentationPath, 'index.html')
    const projectToken = String(project.packageName || project.name || '').trim()
    const projectDestination = `${destination}/${projectToken}`

    if (!existsSync(markerPath)) {
      warn(`[${project.name}] skipped — missing ${path.relative(WORKSPACE_ROOT, markerPath)}`)
      continue
    }

    log(`[${project.name}] uploading to ${projectDestination}`)
    runInherit(`az storage blob upload-batch -d ${shellEscape(projectDestination)} -s ${shellEscape(documentationPath)} --connection-string ${shellEscape(connectionString)} --overwrite`)
  }

  banner('[05] Documentation publish complete')
}

main()
