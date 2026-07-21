/**
 * Options accepted by the `test` executor.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface TestExecutorSchema {
  /**
   * Run `pip install -e .` before pytest. Defaults to `true`; the
   * `function-application` generator sets this to `false` since a function
   * app has no `pyproject.toml` to install.
   */
  installEditable?: boolean
}
