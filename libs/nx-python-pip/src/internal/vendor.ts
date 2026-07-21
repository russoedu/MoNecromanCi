/**
 * Extracts the vendored internal-lib project names from a `pyproject.toml`'s
 * `[tool.mnci-python-pip] vendor = [...]` table.
 *
 * @remarks
 * Plain pip has no bundled-local-dependency feature (the pip-world
 * equivalent of `@nxlv/python`'s `bundleLocalDependencies`), so a project
 * that imports a workspace-internal Python library needs this hand-added
 * entry — the pip-world counterpart of hand-wiring a `dependencies = [...]`
 * entry. This package wires no cross-project Python dependency
 * automatically, for vendoring or otherwise.
 *
 * Parsed with a regex, not a TOML library: this package authors the exact
 * shape of the table it looks for (`generateBuildableProject` never writes
 * this table itself — it is always hand-added after generation), so a
 * regex is sufficient and avoids a TOML dependency for one line.
 *
 * @param pyprojectToml - The `pyproject.toml` file contents.
 * @returns The vendored project names (e.g. `["pycore"]`), or `[]` when the
 * project vendors nothing.
 * @throws Never - a missing/malformed table simply yields an empty array.
 * @typeParam None - this function has no generic type parameters.
 */
export function parseVendorEntries (pyprojectToml: string): string[] {
  const match = /^\s*vendor\s*=\s*\[([^\]]*)\]/m.exec(pyprojectToml)
  if (!match) {
    return []
  }
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replaceAll(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/**
 * Appends module directory names to a `pyproject.toml`'s
 * `[tool.hatch.build.targets.wheel] packages` list.
 *
 * @remarks
 * `generateBuildableProject` always writes this list with just the project's
 * own module; a staged build (see the `build` executor) patches it here to
 * also include each vendored module, so hatchling packages them as real
 * top-level packages in the wheel.
 *
 * @param pyprojectToml - The staged `pyproject.toml` file contents.
 * @param moduleDirectories - The vendored modules' directory names to add.
 * @returns The patched `pyproject.toml` contents.
 * @throws Never - when no `packages` list is found, the content is returned unchanged.
 * @typeParam None - this function has no generic type parameters.
 */
export function addPackagesToWheelTarget (pyprojectToml: string, moduleDirectories: string[]): string {
  return pyprojectToml.replace(/^(\s*packages\s*=\s*)\[([^\]]*)\]/m, (_match, prefix: string, existing: string) => {
    const names = existing
      .split(',')
      .map((entry) => entry.trim().replaceAll(/^["']|["']$/g, ''))
      .filter(Boolean)
    const merged = [...new Set([...names, ...moduleDirectories])]
    return `${prefix}[${merged.map((name) => `"${name}"`).join(', ')}]`
  })
}
