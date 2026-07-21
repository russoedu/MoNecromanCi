/**
 * Options accepted by the `build` executor (none — vendoring is driven
 * entirely by the project's own `pyproject.toml`, not executor options).
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export type BuildExecutorSchema = Record<string, never>
