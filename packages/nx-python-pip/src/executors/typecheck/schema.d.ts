/**
 * Options accepted by the `typecheck` executor (none — the strictness lives in
 * the project's own `pyproject.toml` under `[tool.mypy]`, so the target and a
 * hand-run `python -m mypy .` cannot disagree).
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export type TypecheckExecutorSchema = Record<string, never>
