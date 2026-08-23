import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addProjectConfiguration,
  type GeneratorCallback,
  type ProjectConfiguration,
  type Tree
} from '@nx/devkit'
import { dartPackageName } from './dartPackageName'
import { runFlutter } from './runFlutter'
import { withWorkspaceResolution } from './pubspec'
import { withHtmlLang } from './webIndex'
import { addWorkspaceMember, ensureWorkspaceRoot, memberAnalysisOptions } from './workspace'

/**
 * The `versionActions` path a publishable Dart package points at.
 *
 * @remarks
 * Nx's default implementation reads a `package.json`, which a Dart package
 * does not have — without this override `nx release` fails workspace-wide
 * ("Unable to determine the current version for project X from
 * <root>/package.json"), taking every *other* project's release down with it.
 * Verified empirically against a real `nx release --dry-run`.
 */
const VERSION_ACTIONS = '@mnci/nx-flutter/release/version-actions'

/**
 * Options shared by every Flutter project generator.
 *
 * @remarks
 * `buildable` and `publishable` are what separate the three generators: an app
 * is buildable but never released, a publishable library is the reverse, and an
 * internal library is neither.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface FlutterProjectOptions {
  /** The Nx project name (hyphenated form is kept). */
  name: string
  /** Workspace-relative directory. */
  directory: string
  /** `application` (apps) or `library` (packages/libs). */
  projectType: 'application' | 'library'
  /** Adds the `build`/`package` targets and a `web/` platform directory. */
  buildable?: boolean
  /** Adds a project-level `versionActions` override so `nx release` can version it. */
  publishable?: boolean
  /**
   * The `type:<kind>` tag recorded on the project.
   *
   * @remarks
   * Matches the `--tags=type:<kind>` convention `add/go.ts` uses, so Flutter
   * projects are filterable (`nx run-many --projects=tag:type:flutter-app`)
   * and, more importantly, addressable by release scoping the same way — the
   * mechanism that keeps `go-lib` out of `release.projects`.
   */
  tag: string
}

/** The `lint` target: `flutter analyze`, with info-level issues fatal. */
function lintTarget (): ProjectConfiguration['targets'] {
  return { lint: { executor: '@mnci/nx-flutter:lint', options: {} } }
}

/** The `test` target: `flutter test`. */
function testTarget (): ProjectConfiguration['targets'] {
  return { test: { executor: '@mnci/nx-flutter:test', options: {} } }
}

/**
 * The `build` target for a Flutter web app.
 *
 * @remarks
 * Builds into the workspace-root `dist/apps/<name>/` **directory**, keeping
 * mnci's root-`dist` convention. A directory (rather than a bare file) is
 * required, not just tidy: Nx scans every declared `outputs` entry to cache
 * it, and scanning a file raises `ENOTDIR` — the same trap `add/go.ts`
 * documents for `go build`. `flutter build web --output` writes a directory
 * natively, so this falls out for free.
 *
 * @param name - The project name, used in the output path.
 * @returns The `build` target.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function buildTarget (name: string): ProjectConfiguration['targets'] {
  return {
    build: {
      executor: '@mnci/nx-flutter:build',
      outputs: [`{workspaceRoot}/dist/apps/${name}`],
      options: { outputPath: `dist/apps/${name}` }
    }
  }
}

/**
 * The `package` target: zip the built web bundle into the drop.
 *
 * @remarks
 * The same cross-platform `adm-zip` one-liner every other packaged mnci kind
 * uses, writing `dist/drop/flutter-app-<name>.zip`. The basename is exactly
 * `flutter-app-<name>` because CI derives each per-app build tag from the zip
 * filename — so the tag can never drift from the artifact.
 *
 * @param name - The project name.
 * @returns The `package` target.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function packageTarget (name: string): ProjectConfiguration['targets'] {
  const zip = `dist/drop/flutter-app-${name}.zip`
  const command = `node -e "const fs=require('node:fs');fs.mkdirSync('dist/drop',{recursive:true});const A=require('adm-zip');const z=new A();z.addLocalFolder('dist/apps/${name}');z.writeZip('${zip}')"`
  return {
    package: {
      executor: 'nx:run-commands',
      dependsOn: ['build'],
      outputs: [`{workspaceRoot}/${zip}`],
      options: { command }
    }
  }
}

/**
 * Runs `flutter create` and folds the result into the pub workspace.
 *
 * @remarks
 * Scaffolding is delegated to the official Flutter CLI rather than
 * hand-authored, which is the whole reason this plugin can exist at all:
 * `@nxrocks/nx-flutter` cannot load on Nx 23, but `flutter create` is the
 * tool Flutter itself maintains, so there is no third-party generator in the
 * dependency chain and no template to keep in step with SDK releases.
 *
 * It runs as a `GeneratorCallback` (after Nx flushes the Tree) because
 * `flutter create` writes to the real filesystem, not the virtual one. It is
 * safe to run into a directory Nx has already populated: verified that an
 * existing `project.json` survives untouched. `--platforms=web` keeps the
 * output lean — only `web/` is scaffolded, so no `android/`, `ios/` or
 * desktop directories appear (and CI never needs an Android SDK).
 *
 * Two post-create edits fold the fresh project into the workspace, and both
 * matter: `resolution: workspace` is what makes `pub` resolve this package
 * through the root rather than standalone, and replacing the generated
 * `analysis_options.yaml` routes lint rules through the root config.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param options - The project name, directory and template shape.
 * @returns A callback Nx runs once the Tree is flushed.
 * @throws Error when `flutter create` exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function flutterCreateTask (
  workspaceRoot: string,
  options: FlutterProjectOptions
): GeneratorCallback {
  return () => {
    const packageName = dartPackageName(options.name)
    const template = options.buildable ? 'app' : 'package'
    const arguments_ = [
      'create',
      // `--no-pub` is load-bearing, and its absence is what broke this for real.
      //
      // `flutter create` finishes with an implicit `flutter pub get`. By the time
      // it runs, Nx has already flushed the Tree — which means the ROOT
      // `pubspec.yaml` already lists this project in its `workspace:` block,
      // while the project's own `pubspec.yaml`, which `flutter create` has just
      // written from its template, does not yet carry `resolution: workspace`.
      // That combination is one pub rejects outright: a package named in a
      // workspace must declare it is resolved by that workspace. So the implicit
      // `pub get` fails and takes `flutter create` down with it.
      //
      // `resolution: workspace` is added a few lines below, immediately after
      // this call. Skipping the premature resolve and doing it once at the root
      // afterwards is therefore the whole fix: same end state, in an order pub
      // accepts.
      '--no-pub',
      '--template',
      template,
      '--project-name',
      packageName,
      ...(options.buildable ? ['--platforms', 'web'] : []),
      options.directory
    ]
    // Every invocation goes through `runFlutter`, which uses cross-spawn and
    // reports a spawn failure distinctly from a command failure. See its remarks:
    // calling `spawnSync` directly made this fail on Windows before the process
    // started, and report it as "exit code 1" with no output.
    const created = runFlutter(arguments_, workspaceRoot)
    if (!created.ok) {
      throw new Error(`flutter ${arguments_.join(' ')} ${created.reason}`)
    }

    const pubspecPath = join(workspaceRoot, options.directory, 'pubspec.yaml')
    writeFileSync(pubspecPath, withWorkspaceResolution(readFileSync(pubspecPath, 'utf8')))

    const depth = options.directory.split('/').filter(Boolean).length
    writeFileSync(
      join(workspaceRoot, options.directory, 'analysis_options.yaml'),
      memberAnalysisOptions(depth)
    )

    // `flutter create` writes `<html>` with no `lang`, which @html-eslint's
    // `require-lang` reports as an error — so a freshly generated Flutter app
    // failed `npm run lint` on a file the user never opened. See `withHtmlLang`.
    //
    // Tolerant on purpose: a missing or unreadable file is a no-op, never a
    // failed generation. The project is already created and resolving by now,
    // and an upstream template that fixes this must not start breaking `add`.
    if (options.buildable) {
      const indexPath = join(workspaceRoot, options.directory, 'web/index.html')
      try {
        const contents = readFileSync(indexPath, 'utf8')
        const patched = withHtmlLang(contents)
        if (patched !== contents) {
          writeFileSync(indexPath, patched)
        }
      } catch {
        // Never fail an otherwise-successful generation over the web shell.
      }
    }

    // The resolve `--no-pub` skipped, now that the member declares
    // `resolution: workspace`. Run at the workspace ROOT rather than in the new
    // project, because that is what a pub workspace means: one resolution for
    // every member, into a single root `pubspec.lock`.
    //
    // Failing here is a real failure. `mnci add flutter-app` that leaves a
    // project pub cannot resolve has not produced a working project, and saying
    // so now beats a confusing error at the user's first `flutter run`.
    const resolved = runFlutter(['pub', 'get'], workspaceRoot)
    if (!resolved.ok) {
      throw new Error(`flutter pub get (after creating ${options.directory}) ${resolved.reason}`)
    }
  }
}

/**
 * The Dart-safe package name for the workspace root's own pubspec.
 *
 * @remarks
 * Derived from the root `package.json` name rather than the directory
 * basename: the directory can be renamed, cloned to a different path, or be a
 * CI checkout directory with an unrelated name, whereas the manifest name is
 * the workspace's actual identity. A scoped name (`@acme/demo`) reduces to
 * its last segment, since `@` and `/` are not legal in a Dart identifier.
 *
 * @param tree - The Nx virtual file system.
 * @returns The Dart-safe workspace package name.
 * @throws Never - falls back to `workspace` when the manifest is unreadable.
 * @typeParam None - this function has no generic type parameters.
 */
function workspacePackageName (tree: Tree): string {
  const manifest = tree.read('package.json', 'utf8')
  const name = manifest ? (JSON.parse(manifest) as { name?: string }).name : undefined
  const unscoped = name?.split('/').pop()
  return unscoped ? `${dartPackageName(unscoped)}_workspace` : 'workspace'
}

/**
 * Generates a Flutter/Dart project as a member of the root pub workspace.
 *
 * @remarks
 * Shared by all three generators. The Tree phase writes everything Nx owns
 * (the project config, the root pubspec's `workspace:` entry, the root
 * analyser config); the returned callback then delegates the actual project
 * scaffolding to `flutter create`.
 *
 * @param tree - The Nx virtual file system.
 * @param options - The project name, directory, type and capabilities.
 * @returns A callback Nx runs once the Tree is flushed.
 * @throws Never during the Tree phase; the callback throws on a failed
 * `flutter create`.
 * @typeParam None - this function has no generic type parameters.
 */
export function generateFlutterProject (
  tree: Tree,
  options: FlutterProjectOptions
): GeneratorCallback {
  ensureWorkspaceRoot(tree, workspacePackageName(tree))
  addWorkspaceMember(tree, options.directory)

  const project: ProjectConfiguration = {
    root: options.directory,
    projectType: options.projectType,
    sourceRoot: `${options.directory}/lib`,
    tags: [options.tag],
    targets: {
      ...lintTarget(),
      ...testTarget(),
      ...(options.buildable && buildTarget(options.name)),
      ...(options.buildable && packageTarget(options.name))
    }
  }

  if (options.publishable) {
    project.release = { version: { versionActions: VERSION_ACTIONS } }
  }

  addProjectConfiguration(tree, options.name, project)

  return flutterCreateTask(tree.root, options)
}

export { formatFiles } from '@nx/devkit'
