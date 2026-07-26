import type { GeneratorCallback, Tree } from '@nx/devkit'
import { formatFiles, generateFlutterProject } from '../../internal/generateProject'
import type { InternalLibraryGeneratorSchema } from './schema.d'

/**
 * Generates a private Flutter/Dart package under `libs/`.
 *
 * @remarks
 * Identical machinery to the publishable `library` generator minus the
 * release wiring: `libs/` sits outside `release.projects`, so this project is
 * never versioned, tagged or published. Lint and test targets only — a Dart
 * package produces no build artefact of its own; it is compiled into whatever
 * app depends on it.
 *
 * Consumers depend on it with a **plain version constraint and no `path:`** —
 * being a pub workspace member is what makes that resolve locally.
 *
 * @param tree - The Nx virtual file system.
 * @param options - The project name and directory.
 * @returns A promise resolving to the `flutter create` callback.
 * @throws Never during generation; the callback throws on a failed create.
 * @typeParam None - this function has no generic type parameters.
 */
export default async function internalLibraryGenerator(
  tree: Tree,
  options: InternalLibraryGeneratorSchema
): Promise<GeneratorCallback> {
  const task = generateFlutterProject(tree, {
    name: options.name,
    directory: options.directory ?? `libs/${options.name}`,
    projectType: 'library',
    tag: 'type:flutter-internal-lib',
  })
  await formatFiles(tree)
  return task
}
