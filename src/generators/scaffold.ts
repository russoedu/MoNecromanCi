import { applyFiles, reportApply } from '../engine/apply'
import { addRootDependencies } from '../engine/rootPackage'
import type { FileSpec, NxMagicConfig, ProjectKind, ProjectVars } from '../engine/types'
import { functionAppFiles } from '../templates/functionApp'
import { internalLibFiles } from '../templates/internalLib'
import { cliToolFiles, publishableLibFiles } from '../templates/publishableLib'
import { reactAppFiles } from '../templates/reactApp'
import { logger } from '../util/logger'

interface RootDeps {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** Root dependencies each project kind requires (all deps live in the root). */
const ROOT_DEPENDENCIES: Partial<Record<ProjectKind, RootDeps>> = {
  'function-app': {
    dependencies: { '@azure/functions': '^4.16.0' },
  },
  'react-app': {
    dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0' },
    devDependencies: {
      '@testing-library/jest-dom': '^6.6.3',
      '@testing-library/react': '^16.1.0',
      '@types/react': '^19.2.0',
      '@types/react-dom': '^19.2.0',
      '@vitejs/plugin-react': '^4.3.4',
      'jest-environment-jsdom': '^30.0.0',
      vite: '^6.0.7',
    },
  },
}

function filesForKind (kind: ProjectKind, vars: ProjectVars): FileSpec[] {
  switch (kind) {
    case 'internal-lib':
      return internalLibFiles(vars)
    case 'publishable-lib':
      return publishableLibFiles(vars)
    case 'cli-tool':
      return cliToolFiles(vars)
    case 'function-app':
      return functionAppFiles(vars)
    case 'react-app':
      return reactAppFiles(vars)
    default:
      throw new Error(`The '${kind as string}' generator is not implemented yet.`)
  }
}

/** Public accessor used by `doctor` to recompute a project's expected files. */
export function projectFiles (kind: ProjectKind, vars: ProjectVars): FileSpec[] {
  return filesForKind(kind, vars)
}

function applyRootDependencies (repoRoot: string, kind: ProjectKind): void {
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

/** Writes a single project's files into an existing monorepo. */
export function generateProject (repoRoot: string, kind: ProjectKind, name: string, config: NxMagicConfig): void {
  const vars: ProjectVars = {
    kind,
    name,
    packageName: `${config.scope}/${name}`,
    scope: config.scope,
    azure: config.azure,
  }

  logger.step(`Adding ${kind} '${name}' (${vars.packageName})`)
  reportApply(applyFiles(repoRoot, filesForKind(kind, vars)))
  applyRootDependencies(repoRoot, kind)
}
