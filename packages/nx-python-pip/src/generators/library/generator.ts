import type { Tree } from '@nx/devkit'
import { formatFiles, generateBuildableProject } from '../../internal/generateProject'
import type { LibraryGeneratorSchema } from './schema.d'

/**
 * Generates a publishable pip-native Python library: `pyproject.toml` +
 * `project.json` (lint/test/build/`nx-release-publish`) + a sample module
 * and pytest.
 *
 * @remarks
 * `nx-release-publish` runs `python -m twine upload` (the `publish`
 * executor); the project's own `release.version.versionActions` points at
 * this package's hand-written `PythonVersionActions` implementation, so
 * `nx release` reads/writes `pyproject.toml` correctly regardless of
 * whatever default the consuming workspace's `nx.json` configures (npm's
 * default, typically).
 *
 * @param tree - The Nx virtual file system.
 * @param options - The project name and directory.
 * @returns A promise that resolves once generated files are formatted.
 * @throws Never - pure Tree writes.
 * @typeParam None - this function has no generic type parameters.
 */
export default async function libraryGenerator (tree: Tree, options: LibraryGeneratorSchema): Promise<void> {
  generateBuildableProject(tree, {
    name:        options.name,
    directory:   options.directory ?? `libs/${options.name}`,
    projectType: 'library',
    publishable: true,
  })
  await formatFiles(tree)
}
