import { applyFiles, reportApply } from '../engine/apply'
import { addRootDependencies } from '../engine/rootPackage'
import type { FileSpec, MonecromanciConfig, ProjectKind, ProjectVars } from '../engine/types'
import { svelteAppFiles, vueAppFiles } from '../templates/frontendApp'
import { functionAppFiles } from '../templates/functionApp'
import { internalLibFiles } from '../templates/internalLib'
import { nextAppFiles } from '../templates/nextApp'
import { nodeAppFiles } from '../templates/nodeApp'
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
  'node-app': {
    devDependencies: { tsx: '^4.20.6' },
  },
  'vue-app': {
    dependencies:    { vue: '^3.5.13' },
    devDependencies: { '@vitejs/plugin-vue': '^5.2.4', vite: '^6.0.7' },
  },
  'svelte-app': {
    devDependencies: { '@sveltejs/vite-plugin-svelte': '^5.0.3', svelte: '^5.19.0', vite: '^6.0.7' },
  },
  'nextjs-app': {
    dependencies:    { next: '^15.1.4', react: '^19.2.0', 'react-dom': '^19.2.0' },
    devDependencies: { '@types/react': '^19.2.0', '@types/react-dom': '^19.2.0', 'dotenv-cli': '^8.0.0' },
  },
  'react-app': {
    dependencies:    { react: '^19.2.0', 'react-dom': '^19.2.0' },
    devDependencies: {
      '@testing-library/dom':      '^10.4.0',
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
    case 'node-app': {
      return nodeAppFiles(vars)
    }
    case 'react-app': {
      return reactAppFiles(vars)
    }
    case 'vue-app': {
      return vueAppFiles(vars)
    }
    case 'svelte-app': {
      return svelteAppFiles(vars)
    }
    case 'nextjs-app': {
      return nextAppFiles(vars)
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
    registry:    config.registry,
  }

  logger.step(`Adding ${kind} '${name}' (${vars.packageName})`)
  reportApply(applyFiles(repoRoot, filesForKind(kind, vars)))
  applyRootDependencies(repoRoot, kind)
}
