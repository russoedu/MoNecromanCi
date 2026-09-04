import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCapture } from '../nx'
import { fileExists, readJson, toJson, writeFileEnsured } from '../util/fsx'

/**
 * The four dependency ecosystems a generated workspace can contain.
 *
 * @remarks
 * The set is closed on purpose — it mirrors the project kinds `mnci add`
 * generates, so a new ecosystem here is a deliberate decision rather than
 * something that appears because a stray manifest was found.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type Ecosystem = 'npm' | 'pip' | 'pub' | 'go'

/**
 * Every ecosystem, in the order commands report them.
 *
 * @remarks
 * npm first because it is the only one present in every workspace; Go last
 * because it is the one with nothing to reconcile.
 */
export const ECOSYSTEMS: readonly Ecosystem[] = ['npm', 'pip', 'pub', 'go']

/**
 * The label shown for the workspace root, which is not a project.
 *
 * @remarks
 * Parenthesised so it can never collide with a real directory name in the
 * projects column — a workspace could legitimately contain `apps/root`.
 */
export const ROOT_LABEL = '(root)'

/**
 * One place a package is declared.
 *
 * @remarks
 * A single package name typically has several of these — the same external
 * dependency declared by two projects, or by a project and the root. That list
 * is the whole point: it is what `mnci sync` reconciles and what `mnci up`
 * prints beside each row so the reader can see who is affected before choosing.
 *
 * `rewritable` is separate from the spec itself because "understood well enough
 * to report" and "understood well enough to edit" are different bars. A pub
 * dependency expressed as a `git:` map, or an npm one pointing at a tarball
 * URL, is worth showing and must never be rewritten.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface DependencySite {
  /** The package name, as the manifest spells it. */
  name: string
  /** Which ecosystem's manifest this came from. */
  ecosystem: Ecosystem
  /** Workspace-relative project directory, or {@link ROOT_LABEL}. */
  project: string
  /** Absolute path to the manifest declaring it. */
  manifestPath: string
  /** Short section label for display: `dep`, `devDep`, `peerDep`, … */
  section: string
  /** The declared spec, verbatim. */
  spec: string
  /** Whether {@link rewriteSpec} can safely edit this entry. */
  rewritable: boolean
}

/**
 * Every declaration in the workspace, keyed by package name.
 *
 * @remarks
 * Keyed by name rather than by project because both commands ask the same
 * cross-cutting question — "who declares this, and do they agree?" — which a
 * project-keyed structure answers only after a second pass.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type Inventory = Map<string, DependencySite[]>

/** Where each ecosystem's per-project manifests live, relative to the root. */
const MANIFEST_GLOBS: Record<Ecosystem, string[]> = {
  // `libs/*` carries private internal libs; `packages/*` the publishable ones.
  npm: ['apps/*/package.json', 'libs/*/package.json', 'packages/*/package.json'],
  // Matches PYTHON_PROJECT_DIRS in commands/add/python.ts.
  pip: ['apps/*/pyproject.toml', 'python-packages/*/pyproject.toml', 'libs/*/pyproject.toml'],
  pub: ['apps/*/pubspec.yaml', 'packages/*/pubspec.yaml', 'libs/*/pubspec.yaml'],
  // Single root module by design — there are no per-project Go manifests.
  go: []
}

/**
 * The section label for a peer dependency.
 *
 * @remarks
 * Singled out because a peer range is a **compatibility declaration**, not a
 * version choice, and neither command may rewrite one. `@mnci/nx-python-pip`
 * peers `@nx/devkit` at `>=21.0.0` deliberately, so it loads on Nx 21, 22 and
 * 23 alike; converging that on the 23.x this repo resolves would silently drop
 * support for two majors of consumers. Found by running `mnci sync --check`
 * against this repo, where five of six findings were exactly that mistake.
 */
export const PEER_SECTION = 'peerDep'

/** npm manifest blocks, mapped to the short label shown in a report. */
const NPM_SECTIONS: Record<string, string> = {
  dependencies: 'dep',
  devDependencies: 'devDep',
  peerDependencies: 'peerDep',
  optionalDependencies: 'optionalDep'
}

/**
 * Normalises a `globSync` result to forward slashes.
 *
 * @remarks
 * Load-bearing on Windows, where `globSync` returns `packages\name\file`. The
 * project label derived from these paths is both a display string and the key
 * a user matches against, so a backslash here would make the same project read
 * as two different ones between platforms. This mirrors `toPosix` in
 * `commands/doctor.ts`, whose docblock records the bug that motivated it.
 *
 * @param path - A workspace-relative path from `globSync`.
 * @returns The same path with forward slashes.
 * @throws Never - performs a pure string replacement.
 * @typeParam None - this function has no generic type parameters.
 */
export function toPosix (path: string): string {
  return path.replaceAll('\\', '/')
}

/**
 * The project directory a manifest belongs to.
 *
 * @param manifestRelativePath - Workspace-relative path to the manifest.
 * @returns The directory holding it, forward-slashed.
 * @throws Never - performs string manipulation only.
 * @typeParam None - this function has no generic type parameters.
 */
function projectOf (manifestRelativePath: string): string {
  const posix = toPosix(manifestRelativePath)
  const lastSlash = posix.lastIndexOf('/')
  return lastSlash === -1 ? ROOT_LABEL : posix.slice(0, lastSlash)
}

/**
 * Whether a workspace contains any project of the given ecosystem.
 *
 * @remarks
 * Every command here reports an absent ecosystem as a loud SKIPPED rather than
 * silently omitting it — the pattern the e2e already uses for Go and Flutter,
 * adopted for the same reason: an ecosystem that is quietly dropped stays
 * uncovered for months without anyone noticing.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param ecosystem - The ecosystem to test for.
 * @returns `true` when at least one manifest of that ecosystem exists.
 * @throws Never - only reads the filesystem.
 * @typeParam None - this function has no generic type parameters.
 */
export function hasEcosystem (workspaceRoot: string, ecosystem: Ecosystem): boolean {
  // Go is the only one with no per-project manifest to fall back on.
  if (ecosystem === 'go') {
    return fileExists(join(workspaceRoot, 'go.mod'))
  }
  const rootMarker: Record<Exclude<Ecosystem, 'go'>, string> = {
    npm: 'package.json',
    pip: 'requirements-dev.txt',
    pub: 'pubspec.yaml'
  }
  // Either marker counts. A root file alone is the usual case, but a workspace
  // mid-migration can have projects before it has the root file — reporting
  // nothing there would be the silent-skip failure this whole feature avoids.
  return (
    fileExists(join(workspaceRoot, rootMarker[ecosystem])) ||
    globSync(MANIFEST_GLOBS[ecosystem], { cwd: workspaceRoot }).length > 0
  )
}

/**
 * Reads every npm declaration in the workspace.
 *
 * @remarks
 * Includes the root manifest, because the root is exactly where a shared dev
 * tool legitimately lives and where a runtime dependency legitimately does not
 * — both facts a report is useless without.
 *
 * A spec that is not a plain version range (a `file:`/`git+`/`https:` target,
 * npm's `npm:pkg@range` alias, or a `workspace:` protocol) is recorded with
 * `rewritable: false`. The alias form matters here specifically: mnci's own
 * root manifest pins the dual TypeScript compiler that way
 * (`typescript: npm:@typescript/typescript6@^6.0.2`), and rewriting it as a
 * plain version would silently swap the compiler.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Every npm declaration found.
 * @throws Never - an unreadable manifest is skipped.
 * @typeParam None - this function has no generic type parameters.
 */
function collectNpm (workspaceRoot: string): DependencySite[] {
  const sites: DependencySite[] = []
  const relativePaths = ['package.json', ...globSync(MANIFEST_GLOBS.npm, { cwd: workspaceRoot })]

  for (const relativePath of relativePaths) {
    const manifestPath = join(workspaceRoot, relativePath)
    try {
      const manifest = readJson<Record<string, unknown>>(manifestPath)
      sites.push(...npmManifestSites(manifest, relativePath, manifestPath))
    } catch {
      // A malformed manifest is the workspace's problem to fix, not a reason
      // for the whole report to fail.
    }
  }
  return sites
}

/**
 * Reads every dependency block of one npm manifest.
 *
 * @remarks
 * Split out of {@link collectNpm} so the block loop is not nested inside the
 * manifest loop — three levels of iteration in one function is where a
 * `continue` stops obviously belonging to the loop the reader thinks it does.
 *
 * @param manifest - The parsed manifest.
 * @param relativePath - Its workspace-relative path, for the project label.
 * @param manifestPath - Its absolute path, for a later rewrite.
 * @returns Every declaration in the manifest.
 * @throws Never - a manifest with no dependency block yields an empty list.
 * @typeParam None - this function has no generic type parameters.
 */
function npmManifestSites (
  manifest: Record<string, unknown>,
  relativePath: string,
  manifestPath: string
): DependencySite[] {
  const sites: DependencySite[] = []
  const project = projectOf(relativePath)

  for (const [block, section] of Object.entries(NPM_SECTIONS)) {
    const declared = (manifest[block] ?? {}) as Record<string, string>
    for (const [name, spec] of Object.entries(declared)) {
      sites.push({
        name,
        ecosystem: 'npm',
        project,
        manifestPath,
        section,
        spec,
        // Two independent reasons to refuse a rewrite. A `file:`/`git+`/
        // `https:` target, a `workspace:` protocol or npm's `npm:pkg@range`
        // alias is a shape this cannot safely edit; a peer range is a shape it
        // could edit and must not (see PEER_SECTION).
        rewritable: section !== PEER_SECTION && /^[\^~>=<]*\d/.test(spec.trim())
      })
    }
  }
  return sites
}

/**
 * Splits a PEP 508 requirement into its package name and version spec.
 *
 * @remarks
 * Regex rather than a TOML/PEP 508 parser, following the precedent set by
 * `parseVendorEntries` in `@mnci/nx-python-pip` — pip has no manifest parser in
 * the standard library reachable from Node, and the shapes mnci generates are
 * narrow. Extras (`requests[socks]>=2`) are stripped from the name and folded
 * into the spec, so an extras-carrying entry is reported but never rewritten.
 *
 * @param requirement - One requirement line or array entry.
 * @returns The name and spec, or `undefined` when the line declares nothing.
 * @throws Never - an unrecognised line yields `undefined`.
 * @typeParam None - this function has no generic type parameters.
 */
export function parseRequirement (
  requirement: string
): { name: string, spec: string, rewritable: boolean } | undefined {
  const comment = requirement.indexOf('#')
  const text = (comment === -1 ? requirement : requirement.slice(0, comment)).trim()
  if (!text || text.startsWith('-')) {
    return undefined
  }
  // Anchored, greedy, and followed by nothing — so it cannot backtrack. The
  // rest of the line is sliced off rather than matched, which is what keeps
  // this linear on a pathological input.
  const name = /^[a-z0-9][\w.-]*/i.exec(text)?.[0]
  if (!name) {
    return undefined
  }
  const spec = text.slice(name.length).trim()
  return {
    name,
    spec,
    // Extras, environment markers and compound ranges are reportable only.
    rewritable: !spec.startsWith('[') && !spec.includes(';') && !spec.includes(',')
  }
}

/**
 * Reads every pip declaration in the workspace.
 *
 * @remarks
 * Three manifest shapes, and the split between them IS the root/project policy:
 * `requirements-dev.txt` at the root holds the shared toolchain and nothing
 * else, each `pyproject.toml` holds one project's runtime dependencies, and a
 * Python function app has no `pyproject.toml` at all — only its own
 * `requirements.txt`.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Every pip declaration found.
 * @throws Never - an unreadable manifest is skipped.
 * @typeParam None - this function has no generic type parameters.
 */
function collectPip (workspaceRoot: string): DependencySite[] {
  const sites: DependencySite[] = []

  const push = (relativePath: string, section: string, requirement: string): void => {
    const parsed = parseRequirement(requirement)
    if (!parsed) {
      return
    }
    sites.push({
      name: parsed.name,
      ecosystem: 'pip',
      project: projectOf(relativePath),
      manifestPath: join(workspaceRoot, relativePath),
      section,
      spec: parsed.spec,
      rewritable: parsed.rewritable && parsed.spec !== ''
    })
  }

  const pyprojectPaths = globSync(MANIFEST_GLOBS.pip, { cwd: workspaceRoot })
  for (const relativePath of pyprojectPaths) {
    let content: string
    try {
      content = readFileSync(join(workspaceRoot, relativePath), 'utf8')
    } catch {
      continue
    }
    const declared = pyprojectDependencies(content)
    for (const entry of declared) {
      push(relativePath, 'dep', entry)
    }
  }

  const requirementsPaths = [
    'requirements-dev.txt',
    ...globSync('apps/*/requirements.txt', { cwd: workspaceRoot })
  ]
  for (const relativePath of requirementsPaths) {
    if (!fileExists(join(workspaceRoot, relativePath))) {
      continue
    }
    // The root file is the shared toolchain; an app's own file is its runtime.
    const section = relativePath === 'requirements-dev.txt' ? 'devDep' : 'dep'
    const lines = readFileSync(join(workspaceRoot, relativePath), 'utf8').split(/\r?\n/)
    for (const line of lines) {
      push(relativePath, section, line)
    }
  }

  return sites
}

/**
 * Extracts the entries of a `pyproject.toml`'s `[project] dependencies` array.
 *
 * @remarks
 * Scoped to the `[project]` table deliberately: a `pyproject.toml` can carry a
 * `dependencies` key under other tables (build backends and tool sections both
 * do), and a whole-file regex would sweep those in as runtime requirements.
 *
 * @param content - The file's text.
 * @returns The raw string entries, unquoted.
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
 * Reads every pub declaration in the workspace.
 *
 * @remarks
 * The root `pubspec.yaml` is deliberately NOT read for dependencies: in a Dart
 * pub workspace it carries only the member list and an SDK floor, and mnci
 * writes it with no `dependencies:` block at all. Reading it would invent a
 * root/project conflict that cannot exist.
 *
 * A dependency whose value is a nested map — `git:`, `path:`, `hosted:`, or the
 * bare `flutter:` SDK reference every generated project carries — is recorded
 * with an empty spec and `rewritable: false`. Those are shown in a report and
 * never edited.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Every pub declaration found.
 * @throws Never - an unreadable manifest is skipped.
 * @typeParam None - this function has no generic type parameters.
 */
function collectPub (workspaceRoot: string): DependencySite[] {
  const sites: DependencySite[] = []

  const pubspecPaths = globSync(MANIFEST_GLOBS.pub, { cwd: workspaceRoot })
  for (const relativePath of pubspecPaths) {
    let content: string
    try {
      content = readFileSync(join(workspaceRoot, relativePath), 'utf8')
    } catch {
      continue
    }
    for (const block of ['dependencies', 'dev_dependencies'] as const) {
      for (const entry of pubspecBlockEntries(content, block)) {
        sites.push({
          name: entry.name,
          ecosystem: 'pub',
          project: projectOf(relativePath),
          manifestPath: join(workspaceRoot, relativePath),
          section: block === 'dependencies' ? 'dep' : 'devDep',
          spec: entry.spec,
          rewritable: entry.spec !== ''
        })
      }
    }
  }

  return sites
}

/**
 * Reads one top-level block of a `pubspec.yaml` as name/spec pairs.
 *
 * @remarks
 * A line scanner rather than a YAML parser, the same technique
 * `@mnci/nx-flutter`'s `pubspec.ts` and `workspace.ts` already use to edit
 * these files. It reads only the block's direct children — a nested map
 * (`git:` with an indented `url:` under it) yields an empty spec, which is the
 * signal never to rewrite it.
 *
 * Handles CRLF explicitly. `flutter create` writes CRLF on Windows, and a
 * pattern that assumed LF is precisely how the Flutter internal-dependency
 * injection silently did nothing for months.
 *
 * @param content - The pubspec text.
 * @param block - The top-level key to read.
 * @returns The direct children of that block.
 * @throws Never - an absent block yields an empty list.
 * @typeParam None - this function has no generic type parameters.
 */
export function pubspecBlockEntries (
  content: string,
  block: string
): Array<{ name: string, spec: string }> {
  const lines = content.split(/\r?\n/)
  const start = lines.findIndex(line => line.trimEnd() === `${block}:`)
  if (start === -1) {
    return []
  }

  const entries: Array<{ name: string, spec: string }> = []
  let indent: number | undefined

  const body = lines.slice(start + 1)
  for (const line of body) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue
    }
    const lineIndent = line.length - line.trimStart().length
    if (lineIndent === 0) {
      break
    }
    indent ??= lineIndent
    if (lineIndent > indent) {
      // A nested map's contents — belongs to the entry above, not a new one.
      continue
    }
    if (lineIndent < indent) {
      break
    }
    // Split on the first colon rather than matching the whole line: a value can
    // contain anything, and a pattern that tried to describe it is exactly the
    // shape that backtracks badly on a long line.
    const colon = line.indexOf(':')
    if (colon === -1) {
      continue
    }
    const key = line.slice(0, colon).trim()
    if (/^[a-z_][\w-]*$/i.test(key)) {
      entries.push({ name: key, spec: stripQuotes(line.slice(colon + 1).trim()) })
    }
  }

  return entries
}

/**
 * Removes a single layer of surrounding quotes.
 *
 * @param value - The raw scalar.
 * @returns The value without its surrounding quotes.
 * @throws Never - performs string manipulation only.
 * @typeParam None - this function has no generic type parameters.
 */
function stripQuotes (value: string): string {
  return /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value
}

/**
 * Reads the root `go.mod`'s require block.
 *
 * @remarks
 * Read-only, and there is exactly one manifest by design: mnci's Go layout is a
 * single root module, so a package cannot have two versions in the workspace
 * and there is nothing for `mnci sync` to reconcile. Collected anyway so
 * `mnci up` can report Go modules alongside everything else.
 *
 * Indirect requirements are labelled rather than dropped — `go mod tidy` owns
 * them, so offering one for a direct upgrade would be misleading.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Every module the root `go.mod` requires.
 * @throws Never - an absent or unreadable `go.mod` yields an empty list.
 * @typeParam None - this function has no generic type parameters.
 */
function collectGo (workspaceRoot: string): DependencySite[] {
  const manifestPath = join(workspaceRoot, 'go.mod')
  if (!fileExists(manifestPath)) {
    return []
  }
  let content: string
  try {
    content = readFileSync(manifestPath, 'utf8')
  } catch {
    return []
  }

  const sites: DependencySite[] = Array.from(content.matchAll(
    /^\s*(?:require\s+)?([\w.~-]+(?:\/[\w.~-]+)+)\s+(v\S+)(\s*\/\/\s*indirect)?/gm
  ), match => ({
    name: match[1],
    ecosystem: 'go',
    project: ROOT_LABEL,
    manifestPath,
    section: match[3] ? 'indirect' : 'module',
    spec: match[2],
    rewritable: false
  }))
  return sites
}

/**
 * Builds the workspace-wide dependency inventory.
 *
 * @remarks
 * Pure with respect to the workspace — it only reads — so both `mnci sync` and
 * `mnci up` can build it, and tests can assert against it, without any command
 * having run.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param ecosystems - Which ecosystems to read. Defaults to all four.
 * @returns Every declaration, keyed by package name.
 * @throws Never - unreadable manifests are skipped individually.
 * @typeParam None - this function has no generic type parameters.
 */
export function collectInventory (
  workspaceRoot: string,
  ecosystems: readonly Ecosystem[] = ECOSYSTEMS
): Inventory {
  const readers: Record<Ecosystem, (root: string) => DependencySite[]> = {
    npm: collectNpm,
    pip: collectPip,
    pub: collectPub,
    go: collectGo
  }

  const inventory: Inventory = new Map()
  for (const ecosystem of ecosystems) {
    if (!hasEcosystem(workspaceRoot, ecosystem)) {
      continue
    }
    const sites = readers[ecosystem](workspaceRoot)
    for (const site of sites) {
      const existing = inventory.get(site.name)
      if (existing) {
        existing.push(site)
      } else {
        inventory.set(site.name, [site])
      }
    }
  }
  return inventory
}

/**
 * Rewrites one declaration's spec in place, leaving the rest of the file alone.
 *
 * @remarks
 * Minimal edits rather than parse-and-re-emit for the two text formats: a
 * `pyproject.toml` and a `pubspec.yaml` both carry comments mnci wrote and the
 * user may have added, and round-tripping either through a serialiser would
 * silently discard them. npm manifests are re-emitted through `toJson`, which
 * is what every other mnci write already does and is lossless because JSON has
 * no comments.
 *
 * A site with `rewritable: false` is refused rather than best-effort edited.
 *
 * @param site - The declaration to change.
 * @param spec - The new spec to write.
 * @returns `true` when the file was changed.
 * @throws Propagates any `fs` write error.
 * @typeParam None - this function has no generic type parameters.
 */
export function rewriteSpec (site: DependencySite, spec: string): boolean {
  if (!site.rewritable || spec === site.spec) {
    return false
  }
  const { name } = site

  if (site.ecosystem === 'npm') {
    const manifest = readJson<Record<string, Record<string, string>>>(site.manifestPath)
    const block = Object.entries(NPM_SECTIONS).find(([, label]) => label === site.section)?.[0]
    if (!block || manifest[block]?.[name] === undefined) {
      return false
    }
    manifest[block][name] = spec
    writeFileEnsured(site.manifestPath, toJson(manifest))
    return true
  }

  const before = readFileSync(site.manifestPath, 'utf8')
  const after =
    site.ecosystem === 'pip'
      ? replacePipSpec(before, name, spec)
      : replacePubSpec(before, name, spec)
  if (after === before) {
    return false
  }
  writeFileEnsured(site.manifestPath, after)
  return true
}

/**
 * Replaces a requirement's spec in a `pyproject.toml` or `requirements.txt`.
 *
 * @remarks
 * Anchored on the package name so only that entry moves. The name is escaped
 * before it reaches the pattern: a package name can legally contain `.` and
 * `-`, and an unescaped `.` would match any character, which is how a rewrite
 * of `foo.bar` could land on `fooxbar`.
 *
 * @param content - The file's current text.
 * @param name - The package name.
 * @param spec - The new spec.
 * @returns The updated text, unchanged when no entry matched.
 * @throws Never - performs string replacement only.
 * @typeParam None - this function has no generic type parameters.
 */
export function replacePipSpec (content: string, name: string, spec: string): string {
  const escaped = escapeForRegex(name)
  return content.replaceAll(
    new RegExp(String.raw`(^|["'\s])(${escaped})\s*(?:[<>=!~^][^"'\n,]*)?(?=["'\n]|$)`, 'gm'),
    (match, lead: string, matched: string) => `${lead}${matched}${spec}`
  )
}

/**
 * Replaces a dependency's constraint in a `pubspec.yaml`.
 *
 * @remarks
 * Rewrites only a line whose value is a scalar — a line ending in a bare `:`
 * introduces a nested map and is left untouched, which is the write-side half
 * of the `rewritable: false` contract {@link pubspecBlockEntries} sets.
 *
 * @param content - The file's current text.
 * @param name - The dependency name.
 * @param spec - The new constraint.
 * @returns The updated text, unchanged when no entry matched.
 * @throws Never - performs string replacement only.
 * @typeParam None - this function has no generic type parameters.
 */
export function replacePubSpec (content: string, name: string, spec: string): string {
  return content.replaceAll(
    new RegExp(String.raw`^(\s+${escapeForRegex(name)}:[^\S\n]*)\S[^\n]*$`, 'gm'),
    (match, lead: string) => `${lead}${spec}`
  )
}

/**
 * Escapes a string for literal use inside a regular expression.
 *
 * @param value - The literal text.
 * @returns The escaped text.
 * @throws Never - performs string replacement only.
 * @typeParam None - this function has no generic type parameters.
 */
function escapeForRegex (value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/**
 * Whether a package name belongs to a project inside this workspace.
 *
 * @remarks
 * An internal `@scope/lib` is symlinked by npm and versioned by `nx release`;
 * its declared range is deliberately loose (often `*`) so both the workspace
 * link and the tagged version satisfy it. Neither command may touch one:
 * converging it would break on the next release, and offering to "upgrade" it
 * to whatever is published would replace the local link with a registry copy.
 *
 * npm only. A pip internal lib is vendored and a pub one is a workspace member,
 * so neither is declared under a name this could resolve to a directory.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The package name as declared.
 * @returns `true` when the package is a project in this workspace.
 * @throws Never - only reads the filesystem.
 * @typeParam None - this function has no generic type parameters.
 */
export function isWorkspaceProject (workspaceRoot: string, name: string): boolean {
  const short = name.includes('/') ? name.split('/').at(-1) : name
  return ['apps', 'libs', 'packages'].some(directory =>
    fileExists(join(workspaceRoot, directory, short ?? name, 'package.json'))
  )
}

/**
 * Whether a manifest key resolves to a differently-named package.
 *
 * @remarks
 * npm's `npm:pkg@range` alias lets a manifest install one package under another
 * name, and mnci's own root manifest does exactly that for the dual TypeScript
 * compiler: `typescript` resolves to `@typescript/typescript6`. Asking the
 * registry about the KEY then answers about a different package entirely — the
 * first `mnci up` run on this repo offered "typescript 6.0.2 to 7.0.2", which
 * is real TypeScript's version, not the aliased package's.
 *
 * Detected from the installed tree rather than by pattern-matching the spec,
 * because that is the fact that actually matters: whatever the spec says, the
 * name on disk is what a registry query would have to match.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The package name as declared.
 * @returns `true` when the installed package reports a different name.
 * @throws Never - an uninstalled package reads as not aliased.
 * @typeParam None - this function has no generic type parameters.
 */
export function isAliasedInstall (workspaceRoot: string, name: string): boolean {
  try {
    const installed = readJson<{ name?: string }>(
      join(workspaceRoot, 'node_modules', name, 'package.json')
    )
    return installed.name !== undefined && installed.name !== name
  } catch {
    return false
  }
}

/**
 * The version of a package actually resolved in the workspace.
 *
 * @remarks
 * This is what `mnci sync` reconciles towards, and the choice is deliberate:
 * `@nx/dependency-checks` pins a drifted range to the *installed* version when
 * it auto-fixes, so resolving against the same source is what makes the lint
 * rule and this command agree instead of fighting over the same manifest.
 *
 * npm reads `node_modules`, pub reads the single root `pubspec.lock`, and pip
 * has to ask the interpreter — plain pip has no lockfile, which is why its
 * answer is the weakest of the three and why an absent one falls back to the
 * highest declared range rather than failing.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param ecosystem - Which ecosystem the package belongs to.
 * @param name - The package name.
 * @returns The resolved version, or `undefined` when nothing is installed.
 * @throws Never - every lookup failure yields `undefined`.
 * @typeParam None - this function has no generic type parameters.
 */
export function resolvedVersion (
  workspaceRoot: string,
  ecosystem: Ecosystem,
  name: string
): string | undefined {
  if (ecosystem === 'npm') {
    try {
      return readJson<{ version?: string }>(
        join(workspaceRoot, 'node_modules', name, 'package.json')
      ).version
    } catch {
      return undefined
    }
  }

  if (ecosystem === 'pub') {
    const lockPath = join(workspaceRoot, 'pubspec.lock')
    if (!fileExists(lockPath)) {
      return undefined
    }
    try {
      const match = new RegExp(
        String.raw`^\s{2}${escapeForRegex(name)}:[^]*?^\s+version:\s*["']?([^"'\s]+)`,
        'm'
      ).exec(readFileSync(lockPath, 'utf8'))
      return match?.[1]
    } catch {
      return undefined
    }
  }

  if (ecosystem === 'pip') {
    const python = process.platform === 'win32' ? 'python' : 'python3'
    const result = runCapture(python, ['-m', 'pip', 'show', name], workspaceRoot)
    if (result.status !== 0) {
      return undefined
    }
    return /^Version:\s*(\S+)/m.exec(result.stdout)?.[1]
  }

  // Go: the root go.mod IS the resolved state — one module, one version.
  return undefined
}
