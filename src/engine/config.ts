import { join } from 'node:path'
import { STAMP_FILE, TEMPLATE_VERSION } from './constants'
import { fileExists, readJsonSafe, toJson, writeFileEnsured } from './fsx'
import type { CiProvider, MonorepoVars, NxMagicConfig, RegistryConfig } from './types'

/** The raw on-disk stamp shape, where v1 fields may be missing pre-migration. */
type RawConfig = Omit<NxMagicConfig, 'ci' | 'registry'> & { ci?: CiProvider, registry?: RegistryConfig }

/**
 * Absolute path to a repo's `.nx-magic.json` stamp.
 *
 * @remarks
 * Pure path join; does not check whether the file exists.
 *
 * @param repoRoot - Absolute path to the repo root.
 * @returns The absolute path to the stamp file.
 * @throws Never - performs no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function stampPath (repoRoot: string): string {
  return join(repoRoot, STAMP_FILE)
}

/**
 * Returns whether the given directory looks like an nx-magic monorepo.
 *
 * @remarks
 * Checks only for the presence of the `.nx-magic.json` stamp file.
 *
 * @param repoRoot - Absolute path to the repo root.
 * @returns `true` when the stamp file exists.
 * @throws Never - delegates to {@link fileExists}, which does not throw.
 * @typeParam None - this function has no generic type parameters.
 */
export function isManagedRepo (repoRoot: string): boolean {
  return fileExists(stampPath(repoRoot))
}

/** Upgrades a legacy v1 stamp (Azure-only `azure` field) to the `ci`/`registry` shape. */
function migrateConfig (raw: RawConfig): NxMagicConfig {
  const registry: RegistryConfig = raw.registry
    ?? (raw.azure ? { kind: 'azure-artifacts', ...raw.azure } : { kind: 'npm' })

  return { ...raw, ci: raw.ci ?? 'azure', registry }
}

/**
 * Loads the `.nx-magic.json` stamp, or `undefined` when absent/invalid.
 *
 * @remarks
 * Returns early when {@link isManagedRepo} reports no stamp file. Legacy v1
 * stamps are migrated to the current `ci`/`registry` shape via `migrateConfig`.
 *
 * @param repoRoot - Absolute path to the repo root.
 * @returns The parsed (and migrated) stamp, or `undefined` when missing/invalid.
 * @throws Never - delegates to {@link readJsonSafe}, which swallows parse errors.
 * @typeParam None - this function has no generic type parameters.
 */
export function loadConfig (repoRoot: string): NxMagicConfig | undefined {
  if (!isManagedRepo(repoRoot)) {
    return undefined
  }

  const raw = readJsonSafe<RawConfig | undefined>(stampPath(repoRoot), undefined)
  return raw ? migrateConfig(raw) : undefined
}

/**
 * Writes the `.nx-magic.json` stamp for a repo.
 *
 * @remarks
 * Overwrites any existing stamp file.
 *
 * @param repoRoot - Absolute path to the repo root.
 * @param config - The stamp contents to persist.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error (e.g. permission denied) raised
 * while writing the file.
 * @typeParam None - this function has no generic type parameters.
 */
export function saveConfig (repoRoot: string, config: NxMagicConfig): void {
  writeFileEnsured(stampPath(repoRoot), toJson(config))
}

/**
 * Builds the stamp contents from the monorepo template inputs.
 *
 * @remarks
 * Pure data transform; performs no I/O.
 *
 * @param vars - The monorepo template inputs.
 * @returns The stamp contents to be persisted via {@link saveConfig}.
 * @throws Never - performs no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function configFromVars (vars: MonorepoVars): NxMagicConfig {
  return {
    templateVersion: TEMPLATE_VERSION,
    workspaceName:   vars.workspaceName,
    displayName:     vars.displayName,
    scope:           vars.scope,
    defaultBase:     vars.defaultBase,
    nodeVersion:     vars.nodeVersion,
    ci:              vars.ci,
    registry:        vars.registry,
  }
}
