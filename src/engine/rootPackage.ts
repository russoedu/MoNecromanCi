import { join } from 'node:path'
import { readJsonSafe, toJson, writeFileEnsured } from './fsx'

type DependencySection = 'dependencies' | 'devDependencies'

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
  const manifestPath = join(repoRoot, 'package.json')
  const manifest = readJsonSafe<Record<string, unknown>>(manifestPath, {})
  const existing = (manifest[section] as Record<string, string> | undefined) ?? {}
  const added: string[] = []

  for (const [name, version] of Object.entries(dependencies)) {
    if (Object.hasOwn(existing, name)) {
      continue
    }

    existing[name] = version
    added.push(name)
  }

  manifest[section] = Object.fromEntries(
    Object.entries(existing).toSorted(([left], [right]) => left.localeCompare(right)),
  )
  writeFileEnsured(manifestPath, toJson(manifest))

  return added
}
