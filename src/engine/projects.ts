import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TAGS } from './constants'
import { readJsonSafe } from './fsx'
import type { NxMagicConfig, ProjectKind, ProjectVars } from './types'

function readTags (projectJson: Record<string, unknown>): string[] {
  return Array.isArray(projectJson.tags) ? projectJson.tags.map(String) : []
}

function hasBin (packageJson: Record<string, unknown>): boolean {
  if (packageJson.bin) {
    return true
  }

  const nxMagic = packageJson.nxMagic as { dist?: { bin?: unknown } } | undefined
  return Boolean(nxMagic?.dist?.bin)
}

/** Infers a project's nx-magic kind from its tags (and bin for CLI vs lib). */
function kindFromProject (projectJson: Record<string, unknown>, packageJson: Record<string, unknown>): ProjectKind | undefined {
  const tags = readTags(projectJson)

  if (tags.includes(TAGS.functionApp)) {
    return 'function-app'
  }
  if (tags.includes(TAGS.reactApp)) {
    return 'react-app'
  }
  if (tags.includes(TAGS.internalLib)) {
    return 'internal-lib'
  }
  if (tags.includes(TAGS.publishableLib)) {
    return hasBin(packageJson) ? 'cli-tool' : 'publishable-lib'
  }

  return undefined
}

function scanArea (areaDirectory: string, config: NxMagicConfig): ProjectVars[] {
  const projects: ProjectVars[] = []
  const entries = readdirSync(areaDirectory, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const projectDirectory = join(areaDirectory, entry.name)
    const projectJson = readJsonSafe<Record<string, unknown>>(join(projectDirectory, 'project.json'), {})
    const packageJson = readJsonSafe<Record<string, unknown>>(join(projectDirectory, 'package.json'), {})
    const kind = kindFromProject(projectJson, packageJson)
    if (!kind) {
      continue
    }

    const packageName = typeof packageJson.name === 'string' ? packageJson.name : `${config.scope}/${entry.name}`
    projects.push({ kind, name: entry.name, packageName, scope: config.scope, azure: config.azure })
  }

  return projects
}

/**
 * Scans apps/ and libs/ and returns the nx-magic project descriptors found.
 *
 * @remarks
 * Skips directories that don't carry a recognisable NX project/package kind
 * (see `kindFromProject`).
 *
 * @param repoRoot - Absolute path to the monorepo root.
 * @param config - The monorepo's `.nx-magic.json` stamp.
 * @returns The discovered project descriptors.
 * @throws Never - delegates to {@link readJsonSafe}, which swallows read/parse
 * errors.
 * @typeParam None - this function has no generic type parameters.
 */
export function discoverProjects (repoRoot: string, config: NxMagicConfig): ProjectVars[] {
  const projects: ProjectVars[] = []

  for (const area of ['apps', 'libs']) {
    const areaDirectory = join(repoRoot, area)
    if (existsSync(areaDirectory)) {
      projects.push(...scanArea(areaDirectory, config))
    }
  }

  return projects
}
