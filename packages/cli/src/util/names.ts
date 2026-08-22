/**
 * Validates a workspace or project name before it's used anywhere.
 *
 * @remarks
 * A name becomes, without any transformation, a filesystem path segment
 * (`apps/<name>`), an argv token passed straight to Nx generators, and — for
 * Python and Dart kinds, once hyphens and dots become underscores — a module or
 * package identifier. The charset is what keeps it safe in all of those roles at
 * once: lowercase letters, digits, hyphens and dots, starting with a letter.
 *
 * **Dots are permitted but constrained**, and the constraints are the load-bearing
 * part. A dot is safe in most roles a name plays — a path segment, an npm package
 * name (`socket.io` is precedent), an Nx project name, and the `<kind>-<name>.zip`
 * drop basename CI derives build tags from — but four forms are not, so each is
 * rejected here rather than left to fail later and further away:
 *
 * - a **leading** dot would make a hidden directory (and `.`/`..` are the
 *   traversal segments themselves)
 * - a **trailing** dot cannot appear in a git ref, which `nx release`'s
 *   `{projectName}@{version}` tag is
 * - **consecutive** dots are likewise forbidden in a git ref
 * - a name that is *only* dots has no identifier to derive at all
 *
 * The regex encodes this by requiring at least one `[a-z0-9-]` after every dot,
 * which rules out all four without a separate check per case.
 *
 * Note that the two kinds whose ecosystems reject dots outright do **not** get a
 * narrower charset here — they transform instead: `pythonModuleDirectory` and
 * `dartPackageName` map `.` to `_` exactly as they already do for `-`, since a
 * dot is Python's package separator and pub rejects it. Go needs nothing: Nx's
 * own `names()` helper already treats a dot as a word separator, so
 * `@nx-go/nx-go`'s `package` clause for `my.lib` is a valid `mylib` (verified
 * empirically against the installed plugin, not assumed).
 *
 * Applied uniformly regardless of where the name came from (a CLI flag/
 * positional argument, or an interactive prompt) — `promptText`'s own
 * non-empty check only runs on the *prompted* path, so an explicitly empty
 * flag (`mnci add react-app ""`) previously slipped straight through, since
 * `name ?? await promptText(...)` only substitutes on `null`/`undefined`, not
 * `''`. Calling this right after resolving the name closes that gap too — an
 * empty string fails the same charset check as any other invalid name.
 *
 * @param name - The candidate workspace or project name.
 * @param label - What the name is for, used in the error message (e.g.
 * `'Workspace name'`, `'Project name'`).
 * @returns Nothing.
 * @throws Error when the name is empty, contains a character outside
 * `[a-z0-9-.]`, doesn't start with a lowercase letter, or uses a dot in one of
 * the four rejected positions described above.
 * @typeParam None - this function has no generic type parameters.
 */
export function assertValidProjectName (name: string, label: string): void {
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/.test(name)) {
    throw new Error(
      `${label} '${name}' is invalid — use lowercase letters, digits, hyphens and dots, starting with a letter, with no leading, trailing or repeated dot (e.g. 'my-project', 'my.service').`
    )
  }
}
