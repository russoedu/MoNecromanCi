/**
 * How large an update is, in the buckets `npm-check` groups its output by.
 *
 * @remarks
 * `non-semver` is not "unparseable" — it is `npm-check`'s own fourth bucket,
 * *"Versions less than 1.0.0, caution"*. A `0.x` release makes no compatibility
 * promise, so a `0.1.15` to `0.3.4` bump is neither safely-minor nor
 * loudly-major; grouping it separately is what tells the reader to look. A
 * version this module cannot parse at all lands here too, for the same reason:
 * it deserves attention rather than a confident label.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type UpdateKind = 'patch' | 'minor' | 'major' | 'non-semver'

/**
 * The order sections are printed in, matching `npm-check -u`.
 *
 * @remarks
 * Also the sort key for a report: rows are ordered by this array's index, so
 * the least risky upgrades appear first and the reader meets the safe bulk
 * before the majors.
 */
export const UPDATE_KINDS: readonly UpdateKind[] = ['patch', 'minor', 'major', 'non-semver']

/**
 * The heading and blurb `npm-check` prints above each section.
 *
 * @remarks
 * Reproduced verbatim rather than reworded. `mnci up` is meant to be
 * recognisable to anyone who has run `npm-check -u`, and the wording is the
 * cheapest half of that.
 */
export const UPDATE_KIND_LABELS: Record<UpdateKind, { title: string, blurb: string }> = {
  patch: { title: 'Patch Update', blurb: 'Backwards-compatible bug fixes.' },
  minor: { title: 'Minor Update', blurb: 'New backwards-compatible features.' },
  major: { title: 'Major Update', blurb: 'Potentially breaking API changes. Use caution.' },
  'non-semver': { title: 'Non-Semver', blurb: 'Versions less than 1.0.0, caution.' }
}

/**
 * A parsed release triple plus any prerelease suffix.
 *
 * @remarks
 * Build metadata is deliberately absent: nothing here compares it, and semver
 * says it must be ignored when ordering versions anyway.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface ParsedVersion {
  /** The major segment. */
  major: number
  /** The minor segment. */
  minor: number
  /** The patch segment. */
  patch: number
  /** The prerelease suffix without its leading dash, or `undefined`. */
  prerelease?: string
}

/**
 * The range operators this module understands, longest first.
 *
 * @remarks
 * Order matters: `>=` has to be tested before `>`, or every `>=1.2.3` would be
 * read as `>` with a version of `=1.2.3`. The empty string is not listed — it
 * is the fallback when nothing else matches, i.e. an exact pin.
 */
const RANGE_OPERATORS = ['>=', '<=', '^', '~', '>', '<', '='] as const

/**
 * Parses a bare version string into its numeric triple.
 *
 * @remarks
 * Deliberately narrower than full semver: build metadata is dropped and a
 * prerelease is kept only as an opaque string, because the only decisions this
 * module drives are "is it newer" and "which bucket". Anything with fewer than
 * three numeric segments is rejected rather than defaulted, so a calendar
 * version or a git ref reports as unparseable instead of silently comparing as
 * zero.
 *
 * @param raw - The version text, e.g. `1.2.3` or `2.0.0-beta.1`.
 * @returns The parsed version, or `undefined` when it is not a numeric triple.
 * @throws Never - malformed input yields `undefined`.
 * @typeParam None - this function has no generic type parameters.
 */
export function parseVersion (raw: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/.exec(raw.trim())
  if (!match) {
    return undefined
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
  }
}

/**
 * Reads the leading range operator off a dependency spec.
 *
 * @remarks
 * Returned so a rewrite can preserve whatever the project already chose: a
 * package pinned exactly stays pinned, a caret range stays a caret range. Every
 * write path in this feature routes through here rather than assuming a caret,
 * because silently widening an exact pin is a behaviour change the user never
 * asked for.
 *
 * @param spec - The declared dependency spec.
 * @returns The operator, or an empty string for an exact pin.
 * @throws Never - performs string matching only.
 * @typeParam None - this function has no generic type parameters.
 */
export function rangeOperator (spec: string): string {
  const trimmed = spec.trim()
  return RANGE_OPERATORS.find(operator => trimmed.startsWith(operator)) ?? ''
}

/**
 * Strips a range operator off a dependency spec, leaving the bare version.
 *
 * @remarks
 * Handles the single-constraint specs that actually appear in a manifest mnci
 * generates (`^1.2.3`, `~1.2`, `2.0.0`). A compound range, a URL, a git ref, a
 * `workspace:` alias or npm's `npm:pkg@range` form returns `undefined`, which
 * every caller treats as "leave this one alone" — rewriting a spec whose shape
 * is not understood is how a manifest gets corrupted.
 *
 * @param spec - The declared dependency spec.
 * @returns The bare version text, or `undefined` when the spec is not a single
 * operator-plus-version constraint.
 * @throws Never - an unrecognised spec yields `undefined`.
 * @typeParam None - this function has no generic type parameters.
 */
export function specVersion (spec: string): string | undefined {
  const bare = spec.trim().slice(rangeOperator(spec).length).trim()
  return /^\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?$/.test(bare) ? bare : undefined
}

/**
 * Compares two version strings.
 *
 * @remarks
 * A release always sorts above its own prereleases (`1.2.3` beats
 * `1.2.3-beta.1`), which is semver's rule; two prereleases of the same triple
 * are compared as plain strings, which is narrower than semver's
 * segment-by-segment rule but only ever decides which of two prereleases is
 * offered, never whether a release is newer than one.
 *
 * @param left - The first version.
 * @param right - The second version.
 * @returns A negative number when `left` is older, positive when newer, `0`
 * when equal or when either side is unparseable.
 * @throws Never - unparseable input compares equal.
 * @typeParam None - this function has no generic type parameters.
 */
export function compareVersions (left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) {
    return 0
  }
  if (a.major !== b.major) {
    return a.major - b.major
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor
  }
  if (a.patch !== b.patch) {
    return a.patch - b.patch
  }
  if (a.prerelease === b.prerelease) {
    return 0
  }
  if (!a.prerelease) {
    return 1
  }
  if (!b.prerelease) {
    return -1
  }
  return a.prerelease < b.prerelease ? -1 : 1
}

/**
 * Whether `candidate` is strictly newer than `current`.
 *
 * @remarks
 * A thin reading of {@link compareVersions}, named so call sites read as the
 * question they are actually asking.
 *
 * @param candidate - The version offered.
 * @param current - The version in hand.
 * @returns `true` when `candidate` is strictly newer.
 * @throws Never - unparseable input yields `false`.
 * @typeParam None - this function has no generic type parameters.
 */
export function isNewer (candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

/**
 * Buckets an upgrade the way `npm-check` groups its report.
 *
 * @remarks
 * The `0.x` test is applied to the CURRENT version, not the latest: a package
 * the workspace is on `0.1.15` of is unpredictable to upgrade regardless of
 * where it is going, whereas one already past `1.0.0` has made a promise the
 * major/minor/patch split can be trusted to describe.
 *
 * @param current - The version in use.
 * @param latest - The version available.
 * @returns Which section the upgrade belongs in.
 * @throws Never - unparseable input yields `non-semver`.
 * @typeParam None - this function has no generic type parameters.
 */
export function classify (current: string, latest: string): UpdateKind {
  const from = parseVersion(current)
  const to = parseVersion(latest)
  if (!from || !to || from.major === 0) {
    return 'non-semver'
  }
  if (from.major !== to.major) {
    return 'major'
  }
  return from.minor === to.minor ? 'patch' : 'minor'
}

/**
 * Picks the highest of a set of declared specs.
 *
 * @remarks
 * The fallback `mnci sync` uses when nothing is installed to resolve against.
 * Specs whose shape {@link specVersion} does not understand
 * are skipped rather than treated as zero, so an unparseable entry can never
 * win and drag every other project down to it.
 *
 * @param specs - The declared specs to choose between.
 * @returns The highest spec, or `undefined` when none is parseable.
 * @throws Never - an all-unparseable set yields `undefined`.
 * @typeParam None - this function has no generic type parameters.
 */
export function highestSpec (specs: readonly string[]): string | undefined {
  let best: string | undefined
  let bestVersion: string | undefined
  for (const spec of specs) {
    const version = specVersion(spec)
    if (!version) {
      continue
    }
    if (!bestVersion || isNewer(version, bestVersion)) {
      best = spec
      bestVersion = version
    }
  }
  return best
}
