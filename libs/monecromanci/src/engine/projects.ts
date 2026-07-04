import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TAGS } from './constants'
import { readJsonSafe } from './fsx'
import type { MonecromanciConfig, ProjectKind, ProjectVars } from './types'

/** Reads the tags array from a parsed project.json. */
function readTags (projectJson: Record<string, unknown>): string[] {
  return Array.isArray(projectJson.tags) ? projectJson.tags.map(String) : []
}

/** Whether the package declares a bin (top-level or via monecromanci.dist). */
function hasBin (packageJson: Record<string, unknown>): boolean {
  if (packageJson.bin) {
    return true
  }

  const marker = packageJson.monecromanci as { dist?: { bin?: unknown } } | undefined
  return Boolean(marker?.dist?.bin)
}

/** Infers a project's MoNecromanCI kind from its tags (and bin for CLI vs lib). */
function kindFromProject (projectJson: Record<string, unknown>, packageJson: Record<string, unknown>): ProjectKind | undefined {
  const tags = readTags(projectJson)

  if (tags.includes(TAGS.functionApp)) {
    return 'function-app'
  }
  if (tags.includes(TAGS.nodeApp)) {
    return 'node-app'
  }
  if (tags.includes(TAGS.reactApp)) {
    return 'react-app'
  }
  if (tags.includes(TAGS.vueApp)) {
    return 'vue-app'
  }
  if (tags.includes(TAGS.svelteApp)) {
    return 'svelte-app'
  }
  if (tags.includes(TAGS.nextjsApp)) {
    return 'nextjs-app'
  }
  if (tags.includes(TAGS.internalLib)) {
    return 'internal-lib'
  }
  if (tags.includes(TAGS.publishableLib)) {
    return hasBin(packageJson) ? 'cli-tool' : 'publishable-lib'
  }

  return undefined
}

/** Collects the managed project descriptors found in one area folder. */
function scanArea (areaDirectory: string, config: MonecromanciConfig): ProjectVars[] {
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
    projects.push({ kind, name: entry.name, packageName, scope: config.scope, registry: config.registry })
  }

  return projects
}

/**
 * Scans apps/ and libs/ and returns the MoNecromanCI project descriptors found.
 *
 * @remarks
 * Skips directories that don't carry a recognisable NX project/package kind
 * (see `kindFromProject`).
 *
 * @param repoRoot - Absolute path to the monorepo root.
 * @param config - The monorepo's `.monecromanci.json` stamp.
 * @returns The discovered project descriptors.
 * @throws Never - delegates to {@link readJsonSafe}, which swallows read/parse
 * errors.
 * @typeParam None - this function has no generic type parameters.
 */
export function discoverProjects (repoRoot: string, config: MonecromanciConfig): ProjectVars[] {
  const projects: ProjectVars[] = []

  for (const area of ['apps', 'libs']) {
    const areaDirectory = join(repoRoot, area)
    if (existsSync(areaDirectory)) {
      projects.push(...scanArea(areaDirectory, config))
    }
  }

  return projects
}
