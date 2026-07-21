import { addProjectConfiguration, type ProjectConfiguration, type Tree } from '@nx/devkit'
import { pythonModuleDirectory, pythonPyprojectToml, pythonSampleModule, pythonSampleTest } from './pythonProject'

/** The `nx-release-publish` target for a publishable Python library (twine). */
const PUBLISH_TARGET = {
  executor:  '@mnci/nx-python-pip:publish',
  dependsOn: ['build'],
  options:   {},
}

/**
 * Options shared by every buildable-project generator (`application`, `library`).
 *
 * @remarks
 * `publishable` is the only thing that differs between the `application` and
 * `library` generators — see {@link generateBuildableProject}.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface BuildableProjectOptions {
  /** The project name. */
  name:         string
  /** Workspace-relative directory. */
  directory:    string
  /** `application` (apps) or `library` (libs/python-packages). */
  projectType:  'application' | 'library'
  /** Adds a `nx-release-publish` target + a project-level `versionActions` override. */
  publishable?: boolean
}

/**
 * Writes a buildable Python project: `pyproject.toml` + `project.json`
 * (lint/test/build[/publish]) + a sample module and pytest.
 *
 * @remarks
 * Shared by the `application` and `library` generators — the only difference
 * between an app and a publishable lib is whether `publishable` adds the
 * `nx-release-publish` target and the project-level
 * `release.version.versionActions` override pointing at this package's own
 * hand-written `PythonVersionActions` implementation
 * (`@mnci/nx-python-pip/release/version-actions`), which wins over any
 * workspace-level default for just this project — the same mechanism
 * `@nxlv/python`'s own `--publishable` flag used.
 *
 * @param tree - The Nx virtual file system.
 * @param options - The project name, directory, type and publishability.
 * @returns Nothing.
 * @throws Never - pure Tree writes.
 * @typeParam None - this function has no generic type parameters.
 */
export function generateBuildableProject (tree: Tree, options: BuildableProjectOptions): void {
  const moduleDirectory = pythonModuleDirectory(options.name)
  const root = options.directory

  const targets: ProjectConfiguration['targets'] = {
    lint:  { executor: '@mnci/nx-python-pip:lint', options: {} },
    test:  { executor: '@mnci/nx-python-pip:test', options: {} },
    build: { executor: '@mnci/nx-python-pip:build', outputs: ['{projectRoot}/dist'], options: {} },
  }

  const project: ProjectConfiguration = {
    root,
    projectType: options.projectType,
    sourceRoot:  root,
    targets,
  }

  if (options.publishable) {
    targets['nx-release-publish'] = PUBLISH_TARGET
    project.release = { version: { versionActions: '@mnci/nx-python-pip/release/version-actions' } }
  }

  addProjectConfiguration(tree, options.name, project)

  tree.write(`${root}/pyproject.toml`, pythonPyprojectToml(options.name, moduleDirectory))
  tree.write(`${root}/${moduleDirectory}/__init__.py`, pythonSampleModule(moduleDirectory))
  tree.write(`${root}/tests/test_${moduleDirectory}.py`, pythonSampleTest(moduleDirectory))
}

export { formatFiles } from '@nx/devkit'
