import type { ExecutorContext } from '@nx/devkit'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectRootFrom } from '../../internal/executorContext'
import { pythonCommand } from '../../internal/pythonCommand'
import { pythonModuleDirectory } from '../../internal/pythonProject'
import { addPackagesToWheelTarget, parseVendorEntries } from '../../internal/vendor'
import type { BuildExecutorSchema } from './schema.d'

/**
 * Resolves a vendored project's workspace-relative root via the Nx project
 * graph (not a hard-coded `libs/<name>` path) — the same lookup
 * {@link projectRootFrom} uses for the project under build itself.
 *
 * @param name - The vendored project's Nx project name.
 * @param context - The Nx executor context.
 * @returns The workspace-relative root, or `undefined` when no project with
 * that name is registered.
 * @throws Never - an unresolvable name yields `undefined`, not a throw; the
 * caller surfaces it as a normal `python -m build` failure (a missing
 * source directory), not a confusing internal error.
 * @typeParam None - this function has no generic type parameters.
 */
function vendoredProjectRoot (name: string, context: ExecutorContext): string | undefined {
  return context.projectsConfigurations?.projects[name]?.root
}

/**
 * Builds a Python project's wheel/sdist via `python -m build`.
 *
 * @remarks
 * When the project's `pyproject.toml` declares a `vendor` entry (see
 * `parseVendorEntries`), each named project's module directory is copied
 * into a staged copy of the project before building, and the staged
 * `pyproject.toml`'s wheel `packages` list is patched to include it — so the
 * built wheel contains the vendored module as a real top-level package, with
 * no separate install needed by whoever installs the published wheel.
 * Projects with no `vendor` entry build straight from their own directory,
 * no staging.
 *
 * @param _options - Unused (vendoring is driven by `pyproject.toml`, not options).
 * @param context - The Nx executor context.
 * @returns `{ success: true }` when `python -m build` exits 0.
 * @throws Never - failures surface through the returned `success: false`.
 * @typeParam None - this function has no generic type parameters.
 */
export default async function buildExecutor (_options: BuildExecutorSchema, context: ExecutorContext): Promise<{ success: boolean }> {
  const projectRoot = projectRootFrom(context)
  const absoluteProjectRoot = join(context.root, projectRoot)
  const outDirectory = join(absoluteProjectRoot, 'dist')
  const pyprojectPath = join(absoluteProjectRoot, 'pyproject.toml')
  const pyprojectToml = readFileSync(pyprojectPath, 'utf8')
  const vendorNames = parseVendorEntries(pyprojectToml)

  if (vendorNames.length === 0) {
    const result = spawnSync(pythonCommand(), ['-m', 'build', '--outdir', outDirectory, absoluteProjectRoot], { stdio: 'inherit' })
    return { success: result.status === 0 }
  }

  const stagingRoot = mkdtempSync(join(tmpdir(), 'nx-python-pip-build-'))
  try {
    cpSync(absoluteProjectRoot, stagingRoot, { recursive: true })

    const moduleDirectories: string[] = []
    for (const name of vendorNames) {
      const vendoredRoot = vendoredProjectRoot(name, context)
      if (!vendoredRoot) {
        console.error(`nx-python-pip build: vendored project "${name}" is not registered in this workspace.`)
        return { success: false }
      }
      const moduleDirectory = pythonModuleDirectory(name)
      cpSync(join(context.root, vendoredRoot, moduleDirectory), join(stagingRoot, moduleDirectory), { recursive: true })
      moduleDirectories.push(moduleDirectory)
    }

    const stagedPyprojectPath = join(stagingRoot, 'pyproject.toml')
    writeFileSync(stagedPyprojectPath, addPackagesToWheelTarget(readFileSync(stagedPyprojectPath, 'utf8'), moduleDirectories))

    const result = spawnSync(pythonCommand(), ['-m', 'build', '--outdir', outDirectory, stagingRoot], { stdio: 'inherit' })
    return { success: result.status === 0 }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}
