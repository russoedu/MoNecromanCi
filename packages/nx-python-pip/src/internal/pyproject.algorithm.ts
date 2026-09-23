/**
 * Pure readers and rewriters for the parts of a `pyproject.toml` that describe
 * a project's identity and its dependencies.
 *
 * @remarks
 * Two consumers need exactly this and nothing more: the dependency-graph
 * plugin, which turns `[project] dependencies` into Nx graph edges, and the
 * release `VersionActions`, which rewrites a dependant's specifier when the
 * project it names is versioned. Keeping the parsing here means those two can
 * never disagree about what a dependency entry is.
 *
 * `@mnci/cli` carries near-identical readers in its own
 * `dependency-management` slice. They are deliberately NOT shared: this is a
 * published Nx plugin usable in any Nx 21+ workspace, and taking a dependency
 * on the CLI to read four lines of TOML would couple every consumer of the
 * plugin to the CLI's release cadence.
 *
 * Every regex here is anchored and non-backtracking, for the same reason the
 * CLI's are: these read user-authored text, and a `pyproject.toml` with a
 * pathological line must not hang the project graph.
 */

/**
 * Reads the distribution name from a `pyproject.toml`'s `[project]` table.
 *
 * @remarks
 * Scoped to `[project]` deliberately. A `pyproject.toml` carries `name` keys
 * under other tables too — `[tool.poetry]`, `[[tool.hatch.envs...]]` — and a
 * whole-file match would return whichever came first.
 *
 * @param content - The file's text.
 * @returns The distribution name, or `undefined` when there is no `[project]`
 * table or it declares no name.
 * @throws Never - a file it cannot read a name from yields `undefined`.
 * @typeParam None - this function has no generic type parameters.
 */
export function pyprojectName (content: string): string | undefined {
  let inProjectTable = false

  for (const line of content.split(/\r?\n/)) {
    const text = line.trim()
    if (text.startsWith('[')) {
      inProjectTable = text === '[project]'
      continue
    }
    if (!inProjectTable) {
      continue
    }
    const match = /^name\s*=\s*["']([^"']*)["']/.exec(text)
    if (match) {
      return match[1]
    }
  }

  return undefined
}

/**
 * Extracts the raw entries of a `pyproject.toml`'s `[project] dependencies`.
 *
 * @remarks
 * Scoped to `[project]` for the same reason as {@link pyprojectName}: build
 * backends and tool tables declare `dependencies` of their own, and sweeping
 * those in would invent runtime requirements a project does not have.
 *
 * @param content - The file's text.
 * @returns The raw requirement strings, unquoted, in declaration order.
 * @throws Never - a file with no such array yields an empty list.
 * @typeParam None - this function has no generic type parameters.
 */
export function pyprojectDependencies (content: string): string[] {
  const entries: string[] = []
  let inProjectTable = false
  let inArray = false

  for (const line of content.split(/\r?\n/)) {
    const text = line.trim()
    if (text.startsWith('[')) {
      // A new table ends both the scope and any array left open inside it.
      inProjectTable = text === '[project]'
      inArray = false
      continue
    }
    if (!inProjectTable) {
      continue
    }
    if (!inArray && /^dependencies\s*=\s*\[/.test(text)) {
      inArray = true
    }
    if (!inArray) {
      continue
    }
    for (const quoted of text.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      entries.push(quoted[1] ?? quoted[2])
    }
    if (text.includes(']')) {
      inArray = false
    }
  }

  return entries
}

/**
 * Normalises a distribution name for comparison, per PEP 503.
 *
 * @remarks
 * `Scanmate.Ink`, `scanmate-ink` and `scanmate_ink` are the SAME distribution
 * to pip, and a `pyproject.toml` may spell a dependency any of those ways
 * while the project it refers to spells its own name another. Comparing the
 * raw strings would silently miss the edge — the failure mode being a graph
 * that looks fine and an `nx affected` that quietly tests too little.
 *
 * @param name - A distribution name as written anywhere.
 * @returns The normalised form: lower-case, runs of `-`, `_` and `.` collapsed
 * to a single `-`.
 * @throws Never - pure string transform.
 * @typeParam None - this function has no generic type parameters.
 */
export function normaliseDistributionName (name: string): string {
  return name.toLowerCase().replaceAll(/[-_.]+/g, '-')
}

/**
 * The distribution name a PEP 508 requirement string refers to.
 *
 * @remarks
 * Anchored, greedy and followed by nothing, so it cannot backtrack; the rest
 * of the line is sliced rather than matched. That is what keeps this linear on
 * a pathological entry, and it is the same shape `@mnci/cli`'s
 * `parseRequirement` settled on after nine
 * `regexp/no-super-linear-backtracking` findings.
 *
 * A URL requirement (`name @ https://...`) still begins with the name, so it
 * is read correctly here; whether it can be REWRITTEN is a separate question,
 * answered by {@link rewriteRequirementVersion}.
 *
 * @param requirement - One entry of a `dependencies` array.
 * @returns The distribution name, or `undefined` for an entry that does not
 * begin with one (a comment, a flag, or empty).
 * @throws Never - an unparseable entry yields `undefined`.
 * @typeParam None - this function has no generic type parameters.
 */
export function requirementName (requirement: string): string | undefined {
  const text = requirement.trim()
  if (!text || text.startsWith('-') || text.startsWith('#')) {
    return undefined
  }

  return /^[a-z0-9][\w.-]*/i.exec(text)?.[0]
}

/**
 * The version specifier of a PEP 508 requirement, as written.
 *
 * @remarks
 * Everything after the name is returned verbatim, extras and environment
 * marker included, because the callers differ in what they do with it:
 * `readCurrentVersionOfDependency` wants only the number, while
 * {@link rewriteRequirementVersion} has to see the whole thing to know
 * whether rewriting it would change what the requirement means.
 *
 * @param requirement - One entry of a `dependencies` array.
 * @returns Everything after the distribution name, trimmed; `''` when the
 * requirement pins nothing.
 * @throws Never - pure string transform.
 * @typeParam None - this function has no generic type parameters.
 */
export function requirementSpecifier (requirement: string): string {
  const name = requirementName(requirement)
  if (name === undefined) {
    return ''
  }

  return requirement.trim().slice(name.length).trim()
}

/** The comparison operators this rewrites, longest first so `>=` beats `>`. */
const OPERATORS = ['===', '~=', '>=', '<=', '==', '!=', '>', '<'] as const

/**
 * Rewrites the version in a requirement string, keeping its operator.
 *
 * @remarks
 * KEEPING THE OPERATOR is the whole point. A workspace that declares
 * `scanmate-ink>=0.23.0` is stating a floor, and rewriting it to
 * `scanmate-ink==0.24.0` would change the dependency's meaning while
 * pretending to be a version bump. This is the Python half of what
 * `nx release` already does to a `package.json` range.
 *
 * Refuses, by returning `undefined`, anything it cannot rewrite without
 * changing meaning:
 *
 * - a compound range (`>=1,<2`) — which of the two bounds is the one being
 *   bumped is not knowable from here;
 * - an entry carrying extras or an environment marker (`[extra]`, `;`);
 * - a direct URL reference (`@ https://...`), which names no version at all;
 * - an unpinned entry, which is a deliberate "any version" and not a stale
 *   one.
 *
 * A refusal is reported by the caller rather than silently skipped: a
 * dependant whose specifier could not be moved is exactly the under-bump the
 * release documentation exists to prevent.
 *
 * @param requirement - The entry as written.
 * @param newVersion - The version to write in.
 * @returns The rewritten entry, or `undefined` when it cannot be rewritten
 * without changing what the requirement means.
 * @throws Never - pure string transform.
 * @typeParam None - this function has no generic type parameters.
 */
export function rewriteRequirementVersion (
  requirement: string,
  newVersion: string,
): string | undefined {
  const name = requirementName(requirement)
  if (name === undefined) {
    return undefined
  }
  const specifier = requirementSpecifier(requirement)
  if (
    specifier === '' ||
    specifier.includes(',') ||
    specifier.includes(';') ||
    specifier.startsWith('[') ||
    specifier.startsWith('@')
  ) {
    return undefined
  }
  const operator = OPERATORS.find(candidate => specifier.startsWith(candidate))
  if (operator === undefined) {
    return undefined
  }

  return `${name}${operator}${newVersion}`
}

/**
 * Replaces one dependency's entry inside a `pyproject.toml`'s text.
 *
 * @remarks
 * Operates on the file's text rather than parsing and re-emitting TOML, so
 * every comment, ordering choice and blank line in a hand-maintained manifest
 * survives untouched. Only the matching entry's quoted string changes.
 *
 * @param content - The file's text.
 * @param distribution - The dependency's distribution name (any spelling; it
 * is compared normalised).
 * @param newVersion - The version to write in.
 * @returns The new text and the entry as it was and as it became, or
 * `undefined` when the dependency is absent or could not be rewritten.
 * @throws Never - a manifest it cannot rewrite yields `undefined`.
 * @typeParam None - this function has no generic type parameters.
 */
export function withRewrittenDependency (
  content: string,
  distribution: string,
  newVersion: string,
): { content: string, from: string, to: string } | undefined {
  const wanted = normaliseDistributionName(distribution)
  const entry = pyprojectDependencies(content).find((candidate) => {
    const name = requirementName(candidate)

    return name !== undefined && normaliseDistributionName(name) === wanted
  })
  if (entry === undefined) {
    return undefined
  }
  const rewritten = rewriteRequirementVersion(entry, newVersion)
  if (rewritten === undefined || rewritten === entry) {
    return undefined
  }

  // The entry is replaced inside its own quotes, so the surrounding quoting
  // style and indentation are preserved exactly as the author wrote them.
  const quoted = new RegExp(String.raw`(["'])${escapeForRegex(entry)}\1`)

  return {
    content: content.replace(quoted, (_match, quote: string) => `${quote}${rewritten}${quote}`),
    from:    entry,
    to:      rewritten,
  }
}

/**
 * Escapes a literal string for safe use inside a regular expression.
 *
 * @param text - The literal to escape.
 * @returns The escaped form.
 * @throws Never - pure string transform.
 * @typeParam None - this function has no generic type parameters.
 */
function escapeForRegex (text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)
}
