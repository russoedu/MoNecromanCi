import { execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_BASE, TAGS } from './constants'
import { fileExists, readJsonSafe, readTextSafe } from './fsx'
import type { AzureConfig, CiProvider, MonorepoVars, ProjectKind, RegistryConfig } from './types'

/**
 * A project-kind guess plus the signals that produced it.
 *
 * @remarks
 * Returned by {@link detectKind}; `evidence` is shown to the user so they can
 * judge (and correct) the guess during `resurrect`.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface DetectedKind {
  kind:     ProjectKind
  evidence: string[]
}

/**
 * An unmanaged project found under apps/ or libs/ during a resurrect scan.
 *
 * @remarks
 * Produced by {@link findCandidates}; consumed by the `resurrect` wizard.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface CandidateProject {
  /** Which area folder the project lives in. */
  area:         'apps' | 'libs'
  /** The folder (and NX project) name. */
  name:         string
  /** Repo-relative path, e.g. `apps/my-api`. */
  path:         string
  /** The npm package name from its package.json, when present. */
  packageName?: string
  /** The heuristic kind guess with its evidence. */
  detected:     DetectedKind
}

/**
 * Everything a resurrect scan learns about the repo's projects.
 *
 * @remarks
 * `managed` projects already carry one of MoNecromanCi's NX tags and are
 * skipped by the wizard; `outside` lists workspace globs (and their matching
 * directories) that live outside the supported apps//libs/ layout.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface CandidateScan {
  candidates: CandidateProject[]
  managed:    string[]
  outside:    string[]
}

/** Merged dependencies + devDependencies of a package.json. */
function allDependencies (packageJson: Record<string, unknown>): Record<string, string> {
  return {
    ...(packageJson.dependencies as Record<string, string> | undefined),
    ...(packageJson.devDependencies as Record<string, string> | undefined),
  }
}

/** Whether the project directory holds a vite config file of any extension. */
function hasViteConfig (projectDirectory: string): boolean {
  return ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']
    .some((name) => fileExists(join(projectDirectory, name)))
}

/**
 * Guesses a project's {@link ProjectKind} from its files and dependencies.
 *
 * @remarks
 * Heuristic only — resurrect always asks the user to confirm. Signals, in
 * priority order: `host.json`/`@azure/functions` (function-app), a `next`
 * dependency (nextjs-app, checked before react since Next.js apps depend on
 * react too), `vue`/`svelte` deps, react deps or a vite config + index.html
 * (react-app). Anything else in apps/ falls back to node-app; in libs/, a
 * `bin` field means cli-tool, a `publishConfig` or non-private package means
 * publishable-lib, and otherwise internal-lib.
 *
 * @param projectDirectory - Absolute path to the project folder.
 * @param area - Which area folder the project lives in (drives the fallback).
 * @returns The guessed kind plus the evidence that produced it.
 * @throws Never - delegates to {@link readJsonSafe}, which swallows read/parse
 * errors.
 * @typeParam None - this function has no generic type parameters.
 */
export function detectKind (projectDirectory: string, area: 'apps' | 'libs'): DetectedKind {
  const packageJson = readJsonSafe<Record<string, unknown>>(join(projectDirectory, 'package.json'), {})
  const dependencies = allDependencies(packageJson)
  const evidence: string[] = []

  if (fileExists(join(projectDirectory, 'host.json'))) {
    evidence.push('has host.json')
  }
  if (dependencies['@azure/functions']) {
    evidence.push('depends on @azure/functions')
  }
  if (evidence.length > 0) {
    return { kind: 'function-app', evidence }
  }

  if (dependencies.next) {
    return { kind: 'nextjs-app', evidence: ['depends on next'] }
  }
  if (dependencies.vue) {
    return { kind: 'vue-app', evidence: ['depends on vue'] }
  }
  if (dependencies.svelte) {
    return { kind: 'svelte-app', evidence: ['depends on svelte'] }
  }

  if (dependencies.react || dependencies['react-dom']) {
    evidence.push('depends on react')
  }
  if (hasViteConfig(projectDirectory) && fileExists(join(projectDirectory, 'index.html'))) {
    evidence.push('has a vite config and index.html')
  }
  if (evidence.length > 0) {
    return { kind: 'react-app', evidence }
  }

  if (area === 'apps') {
    return { kind: 'node-app', evidence: ['app without frontend or Azure Functions signals'] }
  }

  const monecromanci = packageJson.monecromanci as { dist?: { bin?: unknown } } | undefined
  if (packageJson.bin || monecromanci?.dist?.bin) {
    return { kind: 'cli-tool', evidence: ['declares a bin entry'] }
  }

  if (packageJson.publishConfig) {
    evidence.push('has a publishConfig')
  }
  if (packageJson.private !== true) {
    evidence.push('is not marked private')
  }
  if (evidence.length > 0) {
    return { kind: 'publishable-lib', evidence }
  }

  return { kind: 'internal-lib', evidence: ['private package with no app signals'] }
}

/** Whether a project directory already carries one of MoNecromanCi's NX tags. */
function isManagedProject (projectDirectory: string): boolean {
  const projectJson = readJsonSafe<Record<string, unknown>>(join(projectDirectory, 'project.json'), {})
  const tags = Array.isArray(projectJson.tags) ? projectJson.tags.map(String) : []
  return Object.values(TAGS).some((tag) => tags.includes(tag))
}

/** Directories matched by a `prefix/*` workspaces glob that hold a package.json. */
function directoriesForGlob (repoRoot: string, glob: string): string[] {
  if (!glob.endsWith('/*')) {
    return [glob]
  }

  const area = join(repoRoot, glob.slice(0, -2))
  if (!existsSync(area)) {
    return [glob]
  }

  const entries = readdirSync(area, { withFileTypes: true })
  const matches = entries
    .filter((entry) => entry.isDirectory() && fileExists(join(area, entry.name, 'package.json')))
    .map((entry) => `${glob.slice(0, -2)}/${entry.name}`)
  return matches.length > 0 ? matches : [glob]
}

/** Collects the candidates/managed projects of one area folder into `scan`. */
function scanAreaForCandidates (repoRoot: string, area: 'apps' | 'libs', scan: CandidateScan): void {
  const areaDirectory = join(repoRoot, area)
  if (!existsSync(areaDirectory)) {
    return
  }

  const entries = readdirSync(areaDirectory, { withFileTypes: true })
  for (const entry of entries) {
    const projectDirectory = join(areaDirectory, entry.name)
    if (!entry.isDirectory() || !fileExists(join(projectDirectory, 'package.json'))) {
      continue
    }

    const path = `${area}/${entry.name}`
    if (isManagedProject(projectDirectory)) {
      scan.managed.push(path)
      continue
    }

    const packageJson = readJsonSafe<Record<string, unknown>>(join(projectDirectory, 'package.json'), {})
    scan.candidates.push({
      area,
      name:        entry.name,
      path,
      packageName: typeof packageJson.name === 'string' ? packageJson.name : undefined,
      detected:    detectKind(projectDirectory, area),
    })
  }
}

/**
 * Scans a repo for projects that `resurrect` could adopt.
 *
 * @remarks
 * Only `apps/*` and `libs/*` directories holding a package.json are candidates
 * (the layout every template hardcodes). Directories already carrying one of
 * MoNecromanCi's NX tags are reported as `managed` and excluded — this is what
 * makes a partial resurrect resumable on a later run. Root `workspaces` globs
 * outside apps//libs/ are reported (with their matching project directories)
 * as `outside`.
 *
 * @param repoRoot - Absolute path to the repo root.
 * @returns The candidates, already-managed paths, and out-of-layout globs.
 * @throws Never - delegates to {@link readJsonSafe}/`readdirSync` on existing
 * directories only.
 * @typeParam None - this function has no generic type parameters.
 */
export function findCandidates (repoRoot: string): CandidateScan {
  const scan: CandidateScan = { candidates: [], managed: [], outside: [] }

  scanAreaForCandidates(repoRoot, 'apps', scan)
  scanAreaForCandidates(repoRoot, 'libs', scan)

  const rootPackageJson = readJsonSafe<Record<string, unknown>>(join(repoRoot, 'package.json'), {})
  const workspaces = Array.isArray(rootPackageJson.workspaces) ? rootPackageJson.workspaces.map(String) : []
  for (const glob of workspaces) {
    if (glob === 'apps/*' || glob === 'libs/*') {
      continue
    }

    scan.outside.push(...directoriesForGlob(repoRoot, glob))
  }

  return scan
}

const AZURE_REGISTRY_PATTERN = /pkgs\.dev\.azure\.com\/([^/]+)\/([^/]+)\/_packaging\/([^/]+)\//

/** Extracts Azure DevOps coordinates from any Azure Artifacts registry URL in the text. */
function azureFromText (text: string): AzureConfig | undefined {
  const match = AZURE_REGISTRY_PATTERN.exec(text)
  return match ? { organization: match[1], project: match[2], artifactsFeed: match[3] } : undefined
}

/** The repo's default branch, from git's origin/HEAD symref when available. */
function detectDefaultBase (repoRoot: string): string {
  try {
    const reference = execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    return reference.split('/').pop() || DEFAULT_BASE
  } catch {
    return DEFAULT_BASE
  }
}

/** The most common `@scope` prefix among the candidate projects' package names. */
function detectScope (candidates: CandidateProject[]): string | undefined {
  const counts = new Map<string, number>()
  for (const candidate of candidates) {
    if (!candidate.packageName?.startsWith('@')) {
      continue
    }

    const scope = candidate.packageName.split('/', 1)[0]
    counts.set(scope, (counts.get(scope) ?? 0) + 1)
  }

  let best: string | undefined
  for (const [scope, count] of counts) {
    if (best === undefined || count > (counts.get(best) ?? 0)) {
      best = scope
    }
  }
  return best
}

/**
 * Best-effort prompt defaults for resurrecting an existing repo.
 *
 * @remarks
 * Nothing here is trusted blindly — every value is only used as the default of
 * an interactive prompt. Sources: root package.json `name` (workspace/display
 * name), the most common `@scope` among project package names, `engines.node`
 * digits, git's origin/HEAD symref (default branch), existing CI files
 * (`.github/workflows` and/or `azure-pipelines.yml`), and any Azure Artifacts
 * or GitHub Packages registry URL found in `.npmrc` or a project's
 * `publishConfig`.
 *
 * @param repoRoot - Absolute path to the repo root.
 * @param candidates - The projects found by {@link findCandidates}.
 * @returns The subset of {@link MonorepoVars} that could be inferred.
 * @throws Never - all reads go through safe helpers and the git probe is
 * wrapped in try/catch.
 * @typeParam None - this function has no generic type parameters.
 */
export function detectRepoDefaults (repoRoot: string, candidates: CandidateProject[]): Partial<MonorepoVars> {
  const rootPackageJson = readJsonSafe<Record<string, unknown>>(join(repoRoot, 'package.json'), {})
  const defaults: Partial<MonorepoVars> = {}

  if (typeof rootPackageJson.name === 'string' && rootPackageJson.name.length > 0) {
    const bareName = rootPackageJson.name.startsWith('@') ? rootPackageJson.name.split('/', 2)[1] : rootPackageJson.name
    defaults.workspaceName = bareName
    defaults.displayName = bareName
  }

  const scope = detectScope(candidates)
    ?? (typeof rootPackageJson.name === 'string' && rootPackageJson.name.startsWith('@') ? rootPackageJson.name.split('/', 1)[0] : undefined)
  if (scope) {
    defaults.scope = scope
  }

  const engines = rootPackageJson.engines as { node?: string } | undefined
  const nodeDigits = engines?.node ? /\d+/.exec(engines.node) : undefined
  if (nodeDigits) {
    defaults.nodeVersion = nodeDigits[0]
  }

  defaults.defaultBase = detectDefaultBase(repoRoot)

  const ci = detectCi(repoRoot)
  if (ci) {
    defaults.ci = ci
  }

  const registrySources = [
    readTextSafe(join(repoRoot, '.npmrc')),
    ...candidates.map((candidate) => {
      const packageJson = readJsonSafe<Record<string, unknown>>(join(repoRoot, candidate.path, 'package.json'), {})
      const publishConfig = packageJson.publishConfig as { registry?: string } | undefined
      return publishConfig?.registry ?? ''
    }),
  ]
  const registry = detectRegistry(registrySources, defaults.scope)
  if (registry) {
    defaults.registry = registry
  }

  return defaults
}

/** Infers the CI provider(s) from the CI files already present in the repo. */
function detectCi (repoRoot: string): CiProvider | undefined {
  const hasGithub = existsSync(join(repoRoot, '.github', 'workflows'))
  const hasAzure = fileExists(join(repoRoot, 'azure-pipelines.yml'))

  if (hasGithub && hasAzure) {
    return 'both'
  }
  if (hasGithub) {
    return 'github'
  }
  return hasAzure ? 'azure' : undefined
}

/** Infers the publish registry from registry URLs found in .npmrc/publishConfig. */
function detectRegistry (sources: string[], scope: string | undefined): RegistryConfig | undefined {
  for (const source of sources) {
    const azure = azureFromText(source)
    if (azure) {
      return { kind: 'azure-artifacts', ...azure }
    }
    if (source.includes('npm.pkg.github.com')) {
      return { kind: 'github-packages', owner: scope ? scope.replace(/^@/, '') : 'my-org' }
    }
  }
  return undefined
}
