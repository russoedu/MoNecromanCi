import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { CreateDependencies, RawProjectGraphDependency } from '@nx/devkit'
import { DependencyType, validateDependency } from '@nx/devkit'
import { parseVendorEntries } from '../internal/vendor.algorithm'
import {
  normaliseDistributionName,
  pyprojectDependencies,
  pyprojectName,
  requirementName,
} from '../internal/pyproject.algorithm'

/**
 * The Nx `createDependencies` hook: gives Python projects real edges in the
 * project graph.
 *
 * @remarks
 * Without this the plugin contributes NO edges at all, and the consequence is
 * quiet rather than loud: `nx affected` cannot know that changing a Python
 * library should retest the projects that consume it, so a
 * `lint,typecheck,test,build` run over the affected set passes having verified
 * nothing about the consumers. A graph with a missing edge looks exactly like
 * a graph with nothing to say.
 *
 * TWO kinds of edge are contributed, because a Python project declares its
 * internal dependencies in two different places:
 *
 * - `[project] dependencies` — a registry reference, the normal case. The
 *   dependant names the distribution and pip resolves it.
 * - `[tool.mnci-python-pip] vendor` — an internal-lib whose module the `build`
 *   executor COPIES into the dependant's wheel. That is the strongest possible
 *   dependency: the consumer's build output literally contains the other
 *   project's source, so a change there changes the artefact.
 *
 * Both are `DependencyType.static`. A vendored dependency is static by
 * construction, and a registry one is declared in a manifest rather than
 * discovered at runtime, which is the same thing Nx's own npm-manifest edges
 * record.
 *
 * Names are matched through {@link normaliseDistributionName}, never raw:
 * `scanmate_ink` and `scanmate-ink` are the same distribution to pip, and
 * comparing the literal strings is how an edge goes missing without anything
 * reporting it.
 */
export const createDependencies: CreateDependencies = (_options, context) => {
  const dependencies: RawProjectGraphDependency[] = []

  // Distribution name -> Nx project name, for every project that publishes one.
  const byDistribution = new Map<string, string>()
  const manifests = new Map<string, string>()

  for (const [project, config] of Object.entries(context.projects)) {
    const content = readManifest(context.workspaceRoot, config.root)
    if (content === undefined) {
      continue
    }
    manifests.set(project, content)
    const distribution = pyprojectName(content)
    if (distribution !== undefined) {
      byDistribution.set(normaliseDistributionName(distribution), project)
    }
  }

  for (const [project, content] of manifests) {
    /*
     * `posix.join`, never plain `join`. An Nx dependency's `sourceFile` is a
     * workspace-relative path that must be forward-slashed on EVERY platform,
     * and `join` emits `scan\pyproject.toml` on Windows. Nx's own
     * `validateDependency` rejects it outright - which is how this was caught -
     * but the same mistake in a value Nx merely stores would have been a
     * dangling edge nothing reported. Same class as the Tree-path bug already
     * fixed in this package's release actions.
     */
    const sourceFile = posix.join(context.projects[project].root, 'pyproject.toml')
    const required = pyprojectDependencies(content)
      .map(requirement => requirementName(requirement))
      .filter(name => name !== undefined)
      .map(name => byDistribution.get(normaliseDistributionName(name)))

    /*
     * A vendor entry names the Nx PROJECT, not a distribution - that is the
     * shape `parseVendorEntries` reads and the `build` executor acts on - so it
     * is kept as-is rather than looked up through the distribution map.
     */
    /*
     * A plain member read rather than `Object.hasOwn`, which needs `lib:
     * es2022`. Raising `lib` in this package is forbidden: it was tried once
     * and CHANGED THE PUBLISHED OUTPUT, turning class property initialisers
     * into native class fields - a `[[Set]]` to `[[Define]]` change in a class
     * that extends Nx's `VersionActions`.
     */
    const vendored = parseVendorEntries(content)
      .filter(name => context.projects[name] !== undefined)

    // A Set, so a project that both declares and vendors the same dependency
    // contributes one edge rather than two identical ones.
    const targets = new Set(
      [...required, ...vendored].filter(
        (target): target is string => target !== undefined && target !== project,
      ),
    )

    for (const target of targets) {
      const dependency: RawProjectGraphDependency = {
        source: project,
        target,
        type:   DependencyType.static,
        sourceFile,
      }
      /*
       * Nx's own validator, rather than trusting the loop above. It is what
       * turns a typo into a named error at graph-construction time instead of
       * a dangling edge that surfaces much later as a task that will not run.
       */
      validateDependency(dependency, context)
      dependencies.push(dependency)
    }
  }

  return dependencies
}

/**
 * Reads a project's `pyproject.toml`, if it has one.
 *
 * @remarks
 * A missing manifest is the normal case, not an error: most projects in a
 * mixed workspace are not Python, and a Python FUNCTION app deliberately has
 * only a `requirements.txt`. An unreadable one is treated the same way -
 * refusing to build the whole project graph because one file is locked would
 * be a worse failure than one missing edge.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param projectRoot - The project's workspace-relative root.
 * @returns The manifest text, or `undefined` when there is none to read.
 * @throws Never - an unreadable manifest yields `undefined`.
 * @typeParam None - this function has no generic type parameters.
 */
function readManifest (workspaceRoot: string, projectRoot: string): string | undefined {
  try {
    return readFileSync(join(workspaceRoot, projectRoot, 'pyproject.toml'), 'utf8')
  } catch {
    return undefined
  }
}
