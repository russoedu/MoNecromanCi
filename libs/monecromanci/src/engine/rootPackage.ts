import { join } from 'node:path'
import { readJsonSafe, toJson, writeFileEnsured } from './fsx'
import { logger } from '../util/logger'

type DependencySection = 'dependencies' | 'devDependencies'

/** Shared merge core: adds entries, overwriting existing versions only when pinning. */
function mergeDependencies (
  repoRoot: string,
  dependencies: Record<string, string>,
  section: DependencySection,
  shouldOverwrite: boolean,
): string[] {
  const manifestPath = join(repoRoot, 'package.json')
  const manifest = readJsonSafe<Record<string, unknown>>(manifestPath, {})
  const existing = (manifest[section] as Record<string, string> | undefined) ?? {}
  const touched: string[] = []

  for (const [name, version] of Object.entries(dependencies)) {
    if (Object.hasOwn(existing, name) && (!shouldOverwrite || existing[name] === version)) {
      continue
    }

    existing[name] = version
    touched.push(name)
  }

  manifest[section] = Object.fromEntries(
    Object.entries(existing).toSorted(([left], [right]) => left.localeCompare(right)),
  )
  writeFileEnsured(manifestPath, toJson(manifest))

  return touched
}

/**
 * Merges entries into a section of the monorepo ROOT package.json (where all
 * deps live). Only adds names not already present, then sorts the section.
 *
 * @remarks
 * Existing versions for already-present names are left untouched.
 *
 * @param repoRoot - Absolute path to the monorepo root.
 * @param dependencies - Name-to-version-range entries to merge in.
 * @param section - Which `package.json` section to merge into.
 * @returns The names that were newly added (already-present names are skipped).
 * @throws Propagates any Node.js `fs` error (e.g. permission denied) raised
 * while writing `package.json`.
 * @typeParam None - this function has no generic type parameters.
 */
export function addRootDependencies (
  repoRoot: string,
  dependencies: Record<string, string>,
  section: DependencySection = 'dependencies',
): string[] {
  return mergeDependencies(repoRoot, dependencies, section, false)
}

/**
 * Force-pins entries in a section of the monorepo ROOT package.json.
 *
 * @remarks
 * Unlike {@link addRootDependencies}, existing entries whose version range
 * differs are overwritten — used by `resurrect` to pin the toolchain versions
 * the generated config requires. Entries not listed are left untouched.
 *
 * @param repoRoot - Absolute path to the monorepo root.
 * @param dependencies - Name-to-version-range entries to pin.
 * @param section - Which `package.json` section to pin into.
 * @returns The names that were added or whose version changed.
 * @throws Propagates any Node.js `fs` error (e.g. permission denied) raised
 * while writing `package.json`.
 * @typeParam None - this function has no generic type parameters.
 */
export function setRootDependencies (
  repoRoot: string,
  dependencies: Record<string, string>,
  section: DependencySection = 'dependencies',
): string[] {
  return mergeDependencies(repoRoot, dependencies, section, true)
}

/**
 * The parts of a canonical package.json that {@link mergeManifest} can merge
 * into an existing manifest.
 *
 * @remarks
 * Parsed out of the template-generated package.json content by `resurrect`.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface ManifestTemplate {
  scripts?:    Record<string, string>
  workspaces?: string[]
  engines?:    Record<string, string>
}

/**
 * The outcome of a {@link mergeManifest} call.
 *
 * @remarks
 * Returned by {@link mergeManifest}, consumed by `resurrect` and `doctor`.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface MergeManifestResult {
  /** Dotted field names that were added (e.g. `scripts.lint`). */
  added:   string[]
  /** Dotted field names present but whose content differs from the template. */
  drifted: string[]
}

/**
 * Merges canonical manifest fields into an existing package.json without
 * clobbering user content.
 *
 * @remarks
 * `scripts` keys are only added when missing (existing keys with different
 * content are logged as drift and left alone), `workspaces` entries are
 * unioned in, and `engines` keys are set only when absent. Used by `resurrect`
 * for both the root and the per-project manifests, and by `doctor` to flag
 * (never silently rewrite) scripts a template update has since changed.
 *
 * @param directory - Absolute path to the folder holding the package.json.
 * @param template - The canonical fields to merge in.
 * @param options - `dryRun` computes the result without writing the file.
 * @returns The added and drifted dotted field names.
 * @throws Propagates any Node.js `fs` error (e.g. permission denied) raised
 * while writing `package.json`.
 * @typeParam None - this function has no generic type parameters.
 */
export function mergeManifest (directory: string, template: ManifestTemplate, options: { dryRun?: boolean } = {}): MergeManifestResult {
  const manifestPath = join(directory, 'package.json')
  const manifest = readJsonSafe<Record<string, unknown>>(manifestPath, {})
  const added: string[] = []
  const drifted: string[] = []

  if (template.scripts) {
    const scripts = (manifest.scripts as Record<string, string> | undefined) ?? {}
    for (const [name, command] of Object.entries(template.scripts)) {
      if (!Object.hasOwn(scripts, name)) {
        scripts[name] = command
        added.push(`scripts.${name}`)
      } else if (scripts[name] !== command) {
        drifted.push(`scripts.${name}`)
        logger.warn(`script '${name}' differs from the canonical template in ${manifestPath} — left untouched`)
      }
    }
    manifest.scripts = scripts
  }

  if (template.workspaces) {
    const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces.map(String) : []
    for (const glob of template.workspaces) {
      if (workspaces.includes(glob)) {
        continue
      }

      workspaces.push(glob)
      added.push(`workspaces.${glob}`)
    }
    manifest.workspaces = workspaces
  }

  if (template.engines) {
    const engines = (manifest.engines as Record<string, string> | undefined) ?? {}
    for (const [name, range] of Object.entries(template.engines)) {
      if (Object.hasOwn(engines, name)) {
        continue
      }

      engines[name] = range
      added.push(`engines.${name}`)
    }
    manifest.engines = engines
  }

  if (!options.dryRun) {
    writeFileEnsured(manifestPath, toJson(manifest))
  }

  return { added, drifted }
}
