import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../util/logger'
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

/** A project's inferred kind, plus the exact tag string that determined it. */
interface ProjectClassification {
  kind:         ProjectKind
  canonicalTag: string
}

/** Infers a project's MoNecromanCI kind from its tags (and bin for CLI vs lib). */
function kindFromProject (projectJson: Record<string, unknown>, packageJson: Record<string, unknown>): ProjectClassification | undefined {
  const tags = readTags(projectJson)
  const byTag: Array<[string, ProjectKind]> = [
    [TAGS.functionApp, 'function-app'],
    [TAGS.nodeApp, 'node-app'],
    [TAGS.reactApp, 'react-app'],
    [TAGS.vueApp, 'vue-app'],
    [TAGS.svelteApp, 'svelte-app'],
    [TAGS.nextjsApp, 'nextjs-app'],
    [TAGS.internalLib, 'internal-lib'],
  ]

  for (const [canonicalTag, kind] of byTag) {
    if (tags.includes(canonicalTag)) {
      return { kind, canonicalTag }
    }
  }
  if (tags.includes(TAGS.publishableLib)) {
    return { kind: hasBin(packageJson) ? 'cli-tool' : 'publishable-lib', canonicalTag: TAGS.publishableLib }
  }

  return undefined
}

/** Collects the managed project descriptors found in one area folder. */
function scanArea (area: string, areaDirectory: string, config: MonecromanciConfig): ProjectVars[] {
  const projects: ProjectVars[] = []
  const entries = readdirSync(areaDirectory, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const projectDirectory = join(areaDirectory, entry.name)
    const projectJsonPath = join(projectDirectory, 'project.json')
    const projectJson = readJsonSafe<Record<string, unknown>>(projectJsonPath, {})
    const packageJson = readJsonSafe<Record<string, unknown>>(join(projectDirectory, 'package.json'), {})
    const classification = kindFromProject(projectJson, packageJson)
    if (!classification) {
      // `ci:ignore` only opts a project out of the CI pipeline (see
      // classifyProject in the toolchain's context.mjs) — it is never a
      // substitute for a type:* tag here. Without a type:* tag doctor has no
      // template to generate, so a real NX project missing one is genuinely
      // unmanaged: warn instead of silently hiding it (and its tool-owned
      // files, like tsconfig.json) from every future doctor run.
      if (existsSync(projectJsonPath)) {
        logger.warn(`unrecognized project: ${area}/${entry.name} — no recognisable type:* tag in project.json, skipped by doctor (its config files will not be checked or synced). Add a type:* tag (ci:ignore may stay alongside it to keep the project out of CI).`)
      }
      continue
    }

    const { kind, canonicalTag } = classification
    const extraTags = readTags(projectJson).filter((tag) => tag !== canonicalTag)
    const packageName = typeof packageJson.name === 'string' ? packageJson.name : `${config.scope}/${entry.name}`
    projects.push({ kind, name: entry.name, packageName, scope: config.scope, registry: config.registry, extraTags })
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
      projects.push(...scanArea(area, areaDirectory, config))
    }
  }

  return projects
}
