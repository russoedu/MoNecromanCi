import { join } from 'node:path'
import { STAMP_FILE, TEMPLATE_VERSION } from './constants'
import { fileExists, readJsonSafe, toJson, writeFileEnsured } from './fsx'
import type { MonorepoVars, NxMagicConfig } from './types'

/** Absolute path to a repo's `.nx-magic.json` stamp. */
export function stampPath (repoRoot: string): string {
  return join(repoRoot, STAMP_FILE)
}

/** Returns whether the given directory looks like an nx-magic monorepo. */
export function isManagedRepo (repoRoot: string): boolean {
  return fileExists(stampPath(repoRoot))
}

/** Loads the `.nx-magic.json` stamp, or `undefined` when absent/invalid. */
export function loadConfig (repoRoot: string): NxMagicConfig | undefined {
  if (!isManagedRepo(repoRoot)) {
    return undefined
  }

  return readJsonSafe<NxMagicConfig>(stampPath(repoRoot))
}

/** Writes the `.nx-magic.json` stamp for a repo. */
export function saveConfig (repoRoot: string, config: NxMagicConfig): void {
  writeFileEnsured(stampPath(repoRoot), toJson(config))
}

/** Builds the stamp contents from the monorepo template inputs. */
export function configFromVars (vars: MonorepoVars): NxMagicConfig {
  return {
    templateVersion: TEMPLATE_VERSION,
    workspaceName:   vars.workspaceName,
    displayName:     vars.displayName,
    scope:           vars.scope,
    defaultBase:     vars.defaultBase,
    nodeVersion:     vars.nodeVersion,
    azure:           vars.azure,
  }
}
