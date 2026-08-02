import type { GeneratorCallback, Tree } from '@nx/devkit'
import { formatFiles, generateFlutterProject } from '../../internal/generateProject'
import type { LibraryGeneratorSchema } from './schema.d'

/**
 * Generates a publishable Flutter/Dart package under `packages/`.
 *
 * @remarks
 * "Publishable" means the same thing here as it does for `go-lib`, and it is
 * worth being precise: there is **no registry upload step**. Azure Artifacts
 * has no pub/Dart feed type, so a private pub registry is not available on
 * this stack — publishing is the git tag `nx release` creates, and consumers
 * depend on the package by that tag. No `nx-release-publish` target is
 * written because there is nothing to push.
 *
 * What *is* required is the project-level `versionActions` override, added by
 * {@link generateFlutterProject}: without it `nx release` looks for a
 * `package.json` this project does not have and fails for the **whole
 * workspace**, not just this project.
 *
 * @param tree - The Nx virtual file system.
 * @param options - The project name and directory.
 * @returns A promise resolving to the `flutter create` callback.
 * @throws Never during generation; the callback throws on a failed create.
 * @typeParam None - this function has no generic type parameters.
 */
export default async function libraryGenerator(
  tree: Tree,
  options: LibraryGeneratorSchema
): Promise<GeneratorCallback> {
  const task = generateFlutterProject(tree, {
    name: options.name,
    directory: options.directory ?? `packages/${options.name}`,
    projectType: 'library',
    tag: 'type:flutter-lib',
    publishable: true
  })
  await formatFiles(tree)
  return task
}
