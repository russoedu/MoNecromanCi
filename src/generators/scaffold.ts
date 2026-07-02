import { applyFiles, reportApply } from '../engine/apply'
import { addRootDependencies } from '../engine/rootPackage'
import type { FileSpec, MonecromanciConfig, ProjectKind, ProjectVars } from '../engine/types'
import { functionAppFiles } from '../templates/functionApp'
import { internalLibFiles } from '../templates/internalLib'
import { cliToolFiles, publishableLibFiles } from '../templates/publishableLib'
import { reactAppFiles } from '../templates/reactApp'
import { logger } from '../util/logger'

interface RootDependencies {
  dependencies?:    Record<string, string>
  devDependencies?: Record<string, string>
}

/** Root dependencies each project kind requires (all deps live in the root). */
const ROOT_DEPENDENCIES: Partial<Record<ProjectKind, RootDependencies>> = {
  'function-app': {
    dependencies: { '@azure/functions': '^4.16.0' },
  },
  'react-app': {
    dependencies:    { react: '^19.2.0', 'react-dom': '^19.2.0' },
    devDependencies: {
      '@testing-library/jest-dom': '^6.6.3',
      '@testing-library/react':    '^16.1.0',
      '@types/react':              '^19.2.0',
      '@types/react-dom':          '^19.2.0',
      '@vitejs/plugin-react':      '^4.3.4',
      'jest-environment-jsdom':    '^30.0.0',
      vite:                        '^6.0.7',
    },
  },
}

function filesForKind (kind: ProjectKind, vars: ProjectVars): FileSpec[] {
  switch (kind) {
    case 'internal-lib': {
      return internalLibFiles(vars)
    }
    case 'publishable-lib': {
      return publishableLibFiles(vars)
    }
    case 'cli-tool': {
      return cliToolFiles(vars)
    }
    case 'function-app': {
      return functionAppFiles(vars)
    }
    case 'react-app': {
      return reactAppFiles(vars)
    }
    default: {
      throw new Error(`The '${kind as string}' generator is not implemented yet.`)
    }
  }
}

/**
 * Public accessor used by `doctor` to recompute a project's expected files.
 *
 * @remarks
 * Thin wrapper around the internal `filesForKind` dispatch.
 *
 * @param kind - The project kind to generate files for.
 * @param vars - The project's template inputs.
 * @returns The expected file specs for this project.
 * @throws Throws when `kind` is not one of the implemented {@link ProjectKind}
 * values.
 * @typeParam None - this function has no generic type parameters.
 */
export function projectFiles (kind: ProjectKind, vars: ProjectVars): FileSpec[] {
  return filesForKind(kind, vars)
}

/**
 * Merges the root-level dependencies a project kind requires into the
 * monorepo's package.json.
 *
 * @remarks
 * No-op for kinds with no entry in `ROOT_DEPENDENCIES` (only react apps and
 * function apps require extra root deps). Existing versions are never changed.
 *
 * @param repoRoot - Absolute path to the monorepo root.
 * @param kind - The project kind whose root dependencies to apply.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error raised while writing package.json.
 * @typeParam None - this function has no generic type parameters.
 */
export function applyRootDependencies (repoRoot: string, kind: ProjectKind): void {
  const root = ROOT_DEPENDENCIES[kind]
  if (!root) {
    return
  }

  const added = [
    ...(root.dependencies ? addRootDependencies(repoRoot, root.dependencies, 'dependencies') : []),
    ...(root.devDependencies ? addRootDependencies(repoRoot, root.devDependencies, 'devDependencies') : []),
  ]
  if (added.length > 0) {
    logger.step(`added root dependencies: ${added.join(', ')}`)
  }
}

/**
 * Writes a single project's files into an existing monorepo.
 *
 * @remarks
 * Also applies any root-level dependencies the project kind requires (see
 * {@link addRootDependencies}).
 *
 * @param repoRoot - Absolute path to the monorepo root.
 * @param kind - The project kind to generate.
 * @param name - The kebab-case project name.
 * @param config - The monorepo's `.monecromanci.json` stamp.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error raised while writing files, and
 * throws when `kind` is not one of the implemented {@link ProjectKind} values.
 * @typeParam None - this function has no generic type parameters.
 */
export function generateProject (repoRoot: string, kind: ProjectKind, name: string, config: MonecromanciConfig): void {
  const vars: ProjectVars = {
    kind,
    name,
    packageName: `${config.scope}/${name}`,
    scope:       config.scope,
    azure:       config.azure,
  }

  logger.step(`Adding ${kind} '${name}' (${vars.packageName})`)
  reportApply(applyFiles(repoRoot, filesForKind(kind, vars)))
  applyRootDependencies(repoRoot, kind)
}
