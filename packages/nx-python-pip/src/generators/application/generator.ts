import type { Tree } from '@nx/devkit'
import { formatFiles, generateBuildableProject } from '../../internal/generateProject'
import type { AppGeneratorSchema } from './schema.d'

/**
 * Generates a pip-native Python application: `pyproject.toml` + `project.json`
 * (lint/test/build) + a sample module and pytest.
 *
 * @remarks
 * No `nx-release-publish` target and no `release.version.versionActions`
 * override — apps are never released by `nx release` (packed into a deploy
 * artifact instead, by whatever `package`-style target the calling workspace
 * layers on top).
 *
 * @param tree - The Nx virtual file system.
 * @param options - The project name and directory.
 * @returns A promise that resolves once generated files are formatted.
 * @throws Never - pure Tree writes.
 * @typeParam None - this function has no generic type parameters.
 */
export default async function appGenerator (tree: Tree, options: AppGeneratorSchema): Promise<void> {
  generateBuildableProject(tree, {
    name:        options.name,
    directory:   options.directory ?? `apps/${options.name}`,
    projectType: 'application',
  })
  await formatFiles(tree)
}
