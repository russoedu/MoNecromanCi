import type { ExecutorContext } from '@nx/devkit'

/**
 * Resolves the running project's workspace-relative root directory from an
 * executor context.
 *
 * @remarks
 * Shared by every executor in this package, so each one gets the project
 * root (to build the `cwd` it runs pip/pytest/ruff/twine in) the same way.
 *
 * @param context - The Nx executor context.
 * @returns The workspace-relative project root.
 * @throws Error when the context has no resolvable project (should be
 * unreachable — Nx always sets `projectName` for a target invocation).
 * @typeParam None - this function has no generic type parameters.
 */
export function projectRootFrom (context: ExecutorContext): string {
  const projectName = context.projectName
  const root = projectName ? context.projectsConfigurations?.projects[projectName]?.root : undefined
  if (!root) {
    throw new Error('Could not resolve the project root from the executor context.')
  }
  return root
}
