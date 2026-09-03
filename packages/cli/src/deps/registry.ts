import { pool, runCaptureAsync } from '../nx'
import type { Ecosystem } from './inventory'

/**
 * How many registry lookups run at once.
 *
 * @remarks
 * Each one is a process, not a socket, so the ceiling is about file descriptors
 * and CPU rather than politeness to the registry. Eight keeps a hundred-package
 * workspace under ten seconds without saturating a two-core CI agent.
 */
const LOOKUP_CONCURRENCY = 8

/**
 * Latest published version per package name.
 *
 * @remarks
 * A package the registry does not know is simply absent from the map rather
 * than present with an empty value, so a caller reads "no answer" and "no
 * update" the same way — as nothing to offer.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type LatestVersions = Map<string, string>

/**
 * Asks npm for the latest published version of each package.
 *
 * @remarks
 * `npm view` per package rather than a raw HTTPS request to
 * `registry.npmjs.org`, and that is the load-bearing choice in this file.
 * mnci generates workspaces that publish to **Azure Artifacts**, where the feed
 * is reached through a scoped `@scope:registry` line and authenticated with
 * Basic credentials from the workspace `.npmrc`. `npm view` resolves both for
 * free. Hand-rolling that is how the `_authToken`-as-Bearer trap gets walked
 * into a second time: Azure Artifacts answers a PAT sent as a Bearer token with
 * a 401, and only Basic auth works — a distinction npm already knows about and
 * this command has no business re-implementing.
 *
 * `npm outdated --json` was rejected for a different reason: it is
 * workspace-shallow and omits any package whose declared range already covers
 * the latest release, so the patch/minor/major grouping built on it would be
 * silently incomplete.
 *
 * @param names - The package names to look up.
 * @param cwd - The workspace root, so npm reads the workspace `.npmrc`.
 * @returns A promise of the latest version per package that answered.
 * @throws Never - a package the registry does not know is simply absent.
 * @typeParam None - this function has no generic type parameters.
 */
export async function latestNpmVersions (
  names: readonly string[],
  cwd: string
): Promise<LatestVersions> {
  const results = await pool(names, LOOKUP_CONCURRENCY, async name => {
    const result = await runCaptureAsync('npm', ['view', name, 'version', '--json'], cwd)
    if (result.status !== 0) {
      return
    }
    try {
      // `--json` yields a quoted string for a single field, and an array when
      // the spec matched several versions; the last is the newest.
      const parsed: unknown = JSON.parse(result.stdout)
      const version = Array.isArray(parsed) ? (parsed.at(-1) as unknown) : parsed
      return typeof version === 'string' ? ([name, version] as const) : undefined
    } catch {
      return
    }
  })

  return new Map(results.filter(entry => entry !== undefined))
}

/**
 * Asks PyPI (or whichever index pip is configured for) for latest versions.
 *
 * @remarks
 * `pip index versions` is the same call `@mnci/nx-python-pip`'s `VersionActions`
 * already makes to resolve a published version, reused here rather than hitting
 * `pypi.org/pypi/<name>/json` directly for the same reason npm goes through
 * `npm view`: a workspace may be pointed at a private index, and pip's own
 * configuration is the only thing that knows.
 *
 * The command is marked experimental by pip and prints a warning saying so —
 * on stderr, which {@link runCaptureAsync} discards.
 *
 * @param names - The package names to look up.
 * @param cwd - The workspace root.
 * @returns A promise of the latest version per package that answered.
 * @throws Never - an unavailable index yields an empty map.
 * @typeParam None - this function has no generic type parameters.
 */
export async function latestPipVersions (
  names: readonly string[],
  cwd: string
): Promise<LatestVersions> {
  const python = process.platform === 'win32' ? 'python' : 'python3'
  const results = await pool(names, LOOKUP_CONCURRENCY, async name => {
    const result = await runCaptureAsync(python, ['-m', 'pip', 'index', 'versions', name], cwd)
    if (result.status !== 0) {
      return
    }
    // First line is `<name> (<latest>)`; the second lists every version.
    const match = /\(([^)]+)\)/.exec(result.stdout)
    return match ? ([name, match[1]] as const) : undefined
  })

  return new Map(results.filter(entry => entry !== undefined))
}

/**
 * Asks the Go toolchain which required modules have a newer release.
 *
 * @remarks
 * One call for the whole module graph, because `go list` already reports the
 * available update per module in its `Update` field — there is no per-package
 * query to pool. `-json` emits a stream of concatenated objects rather than a
 * JSON array, so the output is split on the object boundary before parsing.
 *
 * @param cwd - The workspace root, which holds the single `go.mod`.
 * @returns A promise of the latest version per module with an update.
 * @throws Never - an absent Go toolchain yields an empty map.
 * @typeParam None - this function has no generic type parameters.
 */
export async function latestGoVersions (cwd: string): Promise<LatestVersions> {
  const result = await runCaptureAsync('go', ['list', '-m', '-u', '-json', 'all'], cwd)
  if (result.status !== 0) {
    return new Map()
  }

  const latest: LatestVersions = new Map()
  for (const chunk of result.stdout.split(/^\}\s*$/m)) {
    const text = `${chunk.trim()}${chunk.trim() ? '}' : ''}`
    if (!text.startsWith('{')) {
      continue
    }
    try {
      const module_ = JSON.parse(text) as { Path?: string, Update?: { Version?: string } }
      if (module_.Path && module_.Update?.Version) {
        latest.set(module_.Path, module_.Update.Version)
      }
    } catch {
      // A partial chunk at the tail of the stream is not an error worth raising.
    }
  }
  return latest
}

/**
 * Asks pub which workspace dependencies have a newer release.
 *
 * @remarks
 * One call, like Go: `flutter pub outdated --json` reports the whole pub
 * workspace in a single pass, which is what a shared `pubspec.lock` means.
 *
 * `latest` is read rather than `resolvable`: `resolvable` is capped by every
 * other constraint in the workspace, so reporting it would hide exactly the
 * upgrades a user runs this command to discover.
 *
 * @param cwd - The workspace root, which holds the root `pubspec.yaml`.
 * @returns A promise of the latest version per package.
 * @throws Never - an absent Flutter SDK yields an empty map.
 * @typeParam None - this function has no generic type parameters.
 */
export async function latestPubVersions (cwd: string): Promise<LatestVersions> {
  const result = await runCaptureAsync('flutter', ['pub', 'outdated', '--json'], cwd)
  if (result.status !== 0) {
    return new Map()
  }

  try {
    const report = JSON.parse(result.stdout) as {
      packages?: Array<{ package?: string, latest?: { version?: string } }>
    }
    const latest: LatestVersions = new Map()
    const packages = report.packages ?? []
    for (const entry of packages) {
      if (entry.package && entry.latest?.version) {
        latest.set(entry.package, entry.latest.version)
      }
    }
    return latest
  } catch {
    return new Map()
  }
}

/**
 * Resolves latest versions for one ecosystem.
 *
 * @remarks
 * The single entry point commands use, so the per-ecosystem asymmetry — two
 * ecosystems answer per package, two answer for the whole graph at once — stays
 * behind one signature instead of leaking into every caller.
 *
 * @param ecosystem - Which ecosystem to query.
 * @param names - The package names, used only by the per-package ecosystems.
 * @param cwd - The workspace root.
 * @returns A promise of the latest version per package that answered.
 * @throws Never - an unavailable toolchain yields an empty map.
 * @typeParam None - this function has no generic type parameters.
 */
export async function latestVersions (
  ecosystem: Ecosystem,
  names: readonly string[],
  cwd: string
): Promise<LatestVersions> {
  switch (ecosystem) {
    case 'npm': {
      return await latestNpmVersions(names, cwd)
    }
    case 'pip': {
      return await latestPipVersions(names, cwd)
    }
    case 'go': {
      return await latestGoVersions(cwd)
    }
    default: {
      return await latestPubVersions(cwd)
    }
  }
}
