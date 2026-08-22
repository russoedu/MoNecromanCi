import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import spawn from 'cross-spawn'
import { logger } from './logger'

/**
 * The published name of this CLI, queried against the npm registry.
 *
 * @remarks
 * Hardcoded rather than read back from the packaged `package.json`: the
 * update notice should point at the package users actually install, which
 * stays true even when the CLI is executed from a renamed local checkout.
 */
const PACKAGE_NAME = '@mnci/cli'

/** How long to wait for the registry before giving up, in milliseconds. */
const REGISTRY_TIMEOUT_MS = 2000

/**
 * Starts a background check for a newer published version of the CLI.
 *
 * @remarks
 * Deliberately synchronous and `void`-returning: the work is handed to
 * `setImmediate` and never awaited, so returning a promise would leave a
 * floating one at the call site — and a rejected floating promise takes the
 * whole process down with an unhandled rejection. Nothing here can reject,
 * and nothing here throws: a failed update check must never affect the
 * command the user actually ran.
 *
 * Two honest caveats about "background". The registry call is a *synchronous*
 * spawn, so once the deferred callback runs it blocks the event loop for as
 * long as the query takes (bounded by {@link REGISTRY_TIMEOUT_MS}); running
 * it in `setImmediate` keeps it off the startup path, not off the thread.
 * And there is no result cache — every eligible invocation queries afresh.
 *
 * Both costs are confined to interactive use: the check is skipped outright
 * unless stdout is a TTY, so CI runs and piped/scripted invocations pay
 * nothing and never have a notice injected into their output.
 *
 * @param currentVersion - The running CLI version (from package.json).
 * @returns Nothing — a newer version is reported on stdout when found.
 * @throws Never - every failure path is swallowed.
 * @typeParam None - this function has no generic type parameters.
 */
export function checkForUpdate (currentVersion: string): void {
  try {
    if (!process.stdout.isTTY) {
      return
    }
    setImmediate(() => {
      try {
        reportIfOutdated(currentVersion)
      } catch {
        // A convenience feature must never break the invoked command.
      }
    })
  } catch {
    // Scheduling itself failing is pathological; ignore it like the rest.
  }
}

/**
 * Queries the registry and prints an update notice when one is warranted.
 *
 * @remarks
 * Uses `cross-spawn` with an argv array rather than `execSync` with a shell
 * string: it keeps the workspace's no-shell-injection invariant, and avoids
 * POSIX-only redirection that would fail outright on a Windows agent.
 *
 * @param currentVersion - The running CLI version.
 * @returns Nothing.
 * @throws Never - a failed or empty query is treated as "no update known".
 * @typeParam None - this function has no generic type parameters.
 */
function reportIfOutdated (currentVersion: string): void {
  const result = spawn.sync('npm', ['view', PACKAGE_NAME, 'version'], {
    encoding: 'utf8',
    timeout: REGISTRY_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  if (result.error || result.status !== 0) {
    return
  }

  const latestVersion = (result.stdout ?? '').trim()
  if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) {
    return
  }

  logger.info('')
  logger.info(`A new version of ${PACKAGE_NAME} is available: ${latestVersion}`)
  logger.info(`  Current version: ${currentVersion}`)
  logger.info(`  Update with: npm install -g ${PACKAGE_NAME}@latest`)
  logger.info('')
}

/**
 * Whether `candidate` is a strictly newer release than `current`.
 *
 * @remarks
 * Compares the numeric major/minor/patch triple left to right, ignoring any
 * prerelease suffix. That is intentionally narrower than full semver: the
 * only decision it drives is whether to print a notice, so treating
 * `1.2.3-beta.1` as `1.2.3` merely suppresses a notice rather than causing a
 * wrong action. A non-numeric segment makes the comparison bail out as "not
 * newer", so a malformed version is silent rather than noisy.
 *
 * @param candidate - The version offered by the registry.
 * @param current - The running version.
 * @returns `true` when `candidate` is strictly newer than `current`.
 * @throws Never - unparseable input yields `false`.
 * @typeParam None - this function has no generic type parameters.
 */
function isNewerVersion (candidate: string, current: string): boolean {
  const candidateParts = releaseTriple(candidate)
  const currentParts = releaseTriple(current)
  if (!candidateParts || !currentParts) {
    return false
  }

  for (const [index, candidatePart] of candidateParts.entries()) {
    if (candidatePart !== currentParts[index]) {
      return candidatePart > currentParts[index]
    }
  }
  return false
}

/**
 * Parses a version string into its numeric major/minor/patch triple.
 *
 * @param version - The version to parse, with any prerelease suffix ignored.
 * @returns The three numbers, or `undefined` when any segment is not numeric.
 * @throws Never - malformed input yields `undefined`.
 * @typeParam None - this function has no generic type parameters.
 */
function releaseTriple (version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/**
 * Reads the CLI's own version from its packaged `package.json`.
 *
 * @remarks
 * Resolved relative to the compiled entry point (`__dirname`, i.e. `dist/`),
 * so the manifest sits one level up. Falls back to `0.0.0` rather than
 * throwing: an unreadable manifest should not stop the CLI from running.
 *
 * @param packageDirectory - Directory holding the compiled entry point.
 * @returns The version string, or `0.0.0` when it cannot be read.
 * @throws Never - any read or parse failure yields the fallback.
 * @typeParam None - this function has no generic type parameters.
 */
export function readCliVersion (packageDirectory: string): string {
  try {
    const manifestPath = join(packageDirectory, '..', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string }
    return manifest.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
