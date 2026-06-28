import { join } from 'node:path'
import { readJsonSafe, toJson, writeFileEnsured } from './fsx'

type DependencySection = 'dependencies' | 'devDependencies'

/**
 * Merges entries into a section of the monorepo ROOT package.json (where all
 * deps live). Only adds names not already present, then sorts the section.
 * Returns the names that were newly added.
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
    if (!existing[name]) {
      existing[name] = version
      added.push(name)
    }
  }

  manifest[section] = Object.fromEntries(
    Object.entries(existing).toSorted(([left], [right]) => left.localeCompare(right)),
  )
  writeFileEnsured(manifestPath, toJson(manifest))

  return added
}
