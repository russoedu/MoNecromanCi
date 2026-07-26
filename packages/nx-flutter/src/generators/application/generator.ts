import type { GeneratorCallback, Tree } from '@nx/devkit'
import { formatFiles, generateFlutterProject } from '../../internal/generateProject'
import type { AppGeneratorSchema } from './schema.d'

/**
 * Generates a Flutter web application under `apps/`.
 *
 * @remarks
 * Gets the full target set — `lint`, `test`, `build` (a `flutter build web`
 * bundle in the workspace-root `dist/apps/<name>/`) and `package` (that
 * bundle zipped into `dist/drop/flutter-app-<name>.zip` for CI's drop
 * artifact). Web is the only platform scaffolded: it needs nothing beyond the
 * Flutter SDK on the agent, whereas an Android build would drag in the whole
 * Android SDK and NDK. Other platforms can be added per-app later with
 * `flutter create --platforms=...`.
 *
 * @param tree - The Nx virtual file system.
 * @param options - The project name and directory.
 * @returns A promise resolving to the `flutter create` callback.
 * @throws Never during generation; the callback throws on a failed create.
 * @typeParam None - this function has no generic type parameters.
 */
export default async function appGenerator(
  tree: Tree,
  options: AppGeneratorSchema
): Promise<GeneratorCallback> {
  const task = generateFlutterProject(tree, {
    name: options.name,
    directory: options.directory ?? `apps/${options.name}`,
    projectType: 'application',
    tag: 'type:flutter-app',
    buildable: true,
  })
  await formatFiles(tree)
  return task
}
