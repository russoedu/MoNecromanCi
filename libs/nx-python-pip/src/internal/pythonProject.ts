/**
 * A Python project's module directory name, derived from its Nx project name.
 *
 * @remarks
 * Python identifiers cannot contain hyphens, so `my-svc` becomes `my_svc`.
 *
 * @param name - The Nx project name.
 * @returns The module directory's basename (e.g. `my_svc`).
 * @throws Never - pure string mapping.
 * @typeParam None - this function has no generic type parameters.
 */
export function pythonModuleDirectory (name: string): string {
  return name.replaceAll('-', '_')
}

/**
 * The `pyproject.toml` written for a buildable Python project (app or lib).
 *
 * @remarks
 * `hatchling` is the PEP 517 backend. The wheel target's `packages` list is
 * explicit (not hatchling's own auto-detection) because the `build` executor
 * patches this exact list when vendoring an internal-lib's module into the
 * wheel (see `parseVendorEntries`). `dependencies` starts empty — external
 * and vendored dependencies alike are wired by hand after generation; no
 * generator wires cross-project Python dependencies automatically.
 *
 * @param name - The project name.
 * @param moduleDirectory - The project's module directory basename.
 * @returns The `pyproject.toml` contents.
 * @throws Never - pure string build.
 * @typeParam None - this function has no generic type parameters.
 */
export function pythonPyprojectToml (name: string, moduleDirectory: string): string {
  return `[project]
name = "${name}"
version = "1.0.0"
description = ""
requires-python = ">=3.9"
dependencies = []

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["${moduleDirectory}"]

[tool.pytest.ini_options]
testpaths = ["tests"]
`
}

/**
 * A sample pure function written into a generated Python project's module.
 *
 * @remarks
 * Gives every generated project a genuinely testable unit out of the box —
 * paired with {@link pythonSampleTest}.
 *
 * @param moduleDirectory - The project's module directory basename.
 * @returns The `<module>/__init__.py` contents.
 * @throws Never - pure string build.
 * @typeParam None - this function has no generic type parameters.
 */
export function pythonSampleModule (moduleDirectory: string): string {
  return `def hello() -> str:
    return "hello from ${moduleDirectory}"
`
}

/**
 * The sample pytest proving a generated Python project's `test` target runs.
 *
 * @remarks
 * Imports {@link pythonSampleModule}'s function, so a fresh project's `test`
 * target is green out of the box, no wiring needed.
 *
 * @param moduleDirectory - The project's module directory basename.
 * @returns The `tests/test_<module>.py` contents.
 * @throws Never - pure string build.
 * @typeParam None - this function has no generic type parameters.
 */
export function pythonSampleTest (moduleDirectory: string): string {
  return `from ${moduleDirectory} import hello


def test_hello() -> None:
    assert hello() == "hello from ${moduleDirectory}"
`
}
