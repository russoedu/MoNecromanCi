import { join } from 'node:path'
import rootPackageJson from '../../package.json'
import { fileExists, readJsonSafe, readTextSafe, toJson, writeFileEnsured } from './fsx'

/**
 * Legacy lint packages the canonical ESLint config supersedes.
 *
 * @remarks
 * These served as (or fed) a repo's pre-MoNecromanCI ESLint setup and directly
 * conflict with the pinned toolchain: `eslint-config-standard` peers on
 * `eslint-plugin-n@^15||^16` (we pin `^18`) and old `eslint`, `neostandard`
 * peers on `eslint@^9`, and `eslint-plugin-import` (standard's companion) caps
 * below ESLint 10. The tool-owned flat config uses none of them, so keeping
 * them only breaks `npm install`.
 */
export const SUPERSEDED_LINT_PACKAGES = [
  'eslint-config-standard',
  'eslint-config-standard-with-typescript',
  'eslint-plugin-import',
  'neostandard',
]

/**
 * Lists the superseded lint packages still present in the root package.json.
 *
 * @remarks
 * Read-only companion to {@link removeSupersededDependencies}; `doctor` uses it
 * to report the conflict without modifying anything.
 *
 * @param repoRoot - Absolute path to the monorepo root.
 * @returns The names found in `dependencies` or `devDependencies`.
 * @throws Never - delegates to {@link readJsonSafe}, which swallows read/parse
 * errors.
 * @typeParam None - this function has no generic type parameters.
 */
export function findSupersededDependencies (repoRoot: string): string[] {
  const manifest = readJsonSafe<Record<string, unknown>>(join(repoRoot, 'package.json'), {})
  const present = {
    ...(manifest.dependencies as Record<string, string> | undefined),
    ...(manifest.devDependencies as Record<string, string> | undefined),
  }
  return SUPERSEDED_LINT_PACKAGES.filter((name) => Object.hasOwn(present, name))
}

/**
 * Removes the superseded lint packages from the root package.json.
 *
 * @remarks
 * Only the names in {@link SUPERSEDED_LINT_PACKAGES} are touched; every other
 * dependency is left exactly as it was. No-op (and no write) when none are
 * present.
 *
 * @param repoRoot - Absolute path to the monorepo root.
 * @returns The names that were removed.
 * @throws Propagates any Node.js `fs` error (e.g. permission denied) raised
 * while writing `package.json`.
 * @typeParam None - this function has no generic type parameters.
 */
export function removeSupersededDependencies (repoRoot: string): string[] {
  const removed = findSupersededDependencies(repoRoot)
  if (removed.length === 0) {
    return removed
  }

  const manifestPath = join(repoRoot, 'package.json')
  const manifest = readJsonSafe<Record<string, unknown>>(manifestPath, {})
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const entries = manifest[section] as Record<string, string> | undefined
    if (entries) {
      for (const name of removed) {
        delete entries[name]
      }
    }
  }
  writeFileEnsured(manifestPath, toJson(manifest))

  return removed
}

/**
 * Core devDependency names every MoNecromanCI-managed repo must keep, mapped
 * to the version this CLI build expects.
 *
 * @remarks
 * `monecromanci` pins to this CLI's own version — `doctor`/`update`'s
 * reproducibility guarantee depends on `npx monecromanci doctor` resolving
 * the exact version a repo was last stamped with, not whatever's latest.
 * `monecromanci-toolchain` pins to the version this CLI itself declares as a
 * dependency, matching `sharedPeerPackage` in `templates/monorepo.ts` (kept
 * as a local, one-line duplicate here rather than importing from
 * `templates/` — `engine/` never depends on `templates/`, only the reverse).
 */
const CORE_TOOL_DEPENDENCIES: Record<string, string> = {
  monecromanci:             `^${rootPackageJson.version}`,
  'monecromanci-toolchain': rootPackageJson.dependencies['monecromanci-toolchain'],
}

/**
 * Lists core tool devDependencies missing from the root package.json.
 *
 * @remarks
 * The shared configs (`eslint.config.mjs`, `tsconfig.base.json`, …), the CI
 * engine scripts and the `doctor`/`update` reproducibility model all resolve
 * from `node_modules/monecromanci` and `node_modules/monecromanci-toolchain`
 * — a repo missing either devDependency (removed by hand, or predating the
 * toolchain split) will fail `npm install`-adjacent commands in confusing
 * ways. `package.json` is a scaffold file `doctor` never rewrites wholesale;
 * this is a targeted, additive check, the same shape as
 * {@link findSupersededDependencies}.
 *
 * @param repoRoot - Absolute path to the monorepo root.
 * @returns The core package names missing from `devDependencies`.
 * @throws Never - delegates to {@link readJsonSafe}, which swallows read/parse
 * errors.
 * @typeParam None - this function has no generic type parameters.
 */
export function findMissingCoreDependencies (repoRoot: string): string[] {
  const manifest = readJsonSafe<Record<string, unknown>>(join(repoRoot, 'package.json'), {})
  const devDependencies = manifest.devDependencies as Record<string, string> | undefined
  return Object.keys(CORE_TOOL_DEPENDENCIES).filter((name) => !devDependencies || !Object.hasOwn(devDependencies, name))
}

/**
 * Adds any missing core tool devDependencies to the root package.json.
 *
 * @remarks
 * Only the missing names (pinned per {@link CORE_TOOL_DEPENDENCIES}) are
 * added; every other dependency is left exactly as it was. No-op (and no
 * write) when both are already present.
 *
 * @param repoRoot - Absolute path to the monorepo root.
 * @returns The names that were added.
 * @throws Propagates any Node.js `fs` error (e.g. permission denied) raised
 * while writing `package.json`.
 * @typeParam None - this function has no generic type parameters.
 */
export function ensureCoreDependencies (repoRoot: string): string[] {
  const missing = findMissingCoreDependencies(repoRoot)
  if (missing.length === 0) {
    return missing
  }

  const manifestPath = join(repoRoot, 'package.json')
  const manifest = readJsonSafe<Record<string, unknown>>(manifestPath, {})
  const devDependencies = { ...(manifest.devDependencies as Record<string, string> | undefined) }
  for (const name of missing) {
    devDependencies[name] = CORE_TOOL_DEPENDENCIES[name]
  }
  manifest.devDependencies = devDependencies
  writeFileEnsured(manifestPath, toJson(manifest))

  return missing
}

const LEGACY_PEER_DEPS_LINES = [
  '; ESLint 10 lands ahead of some plugins\' peer ranges; accept the resolved tree.',
  'legacy-peer-deps=true',
]

/**
 * Whether the repo's `.npmrc` is missing the `legacy-peer-deps` setting.
 *
 * @remarks
 * The canonical toolchain needs it because ESLint 10 is ahead of some plugins'
 * declared peer ranges. Adopted repos keep their pre-existing `.npmrc`
 * (scaffold files are never overwritten), so the setting can be absent there.
 *
 * @param repoRoot - Absolute path to the monorepo root.
 * @returns `true` when the setting is missing (or no `.npmrc` exists).
 * @throws Never - delegates to {@link readTextSafe}, which swallows read errors.
 * @typeParam None - this function has no generic type parameters.
 */
export function isLegacyPeerDependenciesMissing (repoRoot: string): boolean {
  return !readTextSafe(join(repoRoot, '.npmrc')).includes('legacy-peer-deps')
}

/**
 * Appends `legacy-peer-deps=true` to the repo's `.npmrc` when absent.
 *
 * @remarks
 * Non-destructive: existing `.npmrc` content is preserved and the setting is
 * appended (with its explanatory comment); the file is created when missing.
 * No-op when any `legacy-peer-deps` line is already present.
 *
 * @param repoRoot - Absolute path to the monorepo root.
 * @returns Nothing. Use {@link isLegacyPeerDependenciesMissing} to know whether
 * a write would happen.
 * @throws Propagates any Node.js `fs` error (e.g. permission denied) raised
 * while writing the file.
 * @typeParam None - this function has no generic type parameters.
 */
export function ensureLegacyPeerDependencies (repoRoot: string): void {
  if (!isLegacyPeerDependenciesMissing(repoRoot)) {
    return
  }

  const npmrcPath = join(repoRoot, '.npmrc')
  const existing = fileExists(npmrcPath) ? readTextSafe(npmrcPath) : ''
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
  writeFileEnsured(npmrcPath, `${existing}${separator}${LEGACY_PEER_DEPS_LINES.join('\n')}\n`)
}
