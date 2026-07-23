/**
 * Validates a workspace or project name before it's used anywhere.
 *
 * @remarks
 * A name becomes, without any transformation, a filesystem path segment
 * (`apps/<name>`), an argv token passed straight to Nx generators, and — for
 * Python kinds, once hyphens become underscores — a Python module identifier.
 * A conservative charset makes it safe in all three roles at once: lowercase
 * letters, digits and hyphens, starting with a letter.
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
 * @throws Error when the name is empty or contains a character outside
 * `[a-z0-9-]`, or doesn't start with a lowercase letter.
 * @typeParam None - this function has no generic type parameters.
 */
export function assertValidProjectName (name: string, label: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`${label} '${name}' is invalid — use lowercase letters, digits and hyphens, starting with a letter (e.g. 'my-project').`)
  }
}
