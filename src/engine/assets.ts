import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

/**
 * Resolves the bundled `assets/` directory. Works both from `dist/` (after
 * build, where assets sit beside the bundle) and from `src/` during tests by
 * walking up until an `assets` directory is found.
 *
 * Memoized in a closure (rather than a top-level variable) so the result
 * survives across calls without exposing mutable module-level state.
 *
 * @remarks
 * Throws if no `assets` directory is found within 8 levels up from this
 * module's directory.
 */
export const assetsRoot = (() => {
  let cachedRoot: string | undefined

  return (): string => {
    if (cachedRoot) {
      return cachedRoot
    }

    let directory = __dirname
    for (let level = 0; level < 8; level++) {
      const candidate = join(directory, 'assets')
      if (existsSync(candidate)) {
        cachedRoot = candidate
        return candidate
      }

      const parent = dirname(directory)
      if (parent === directory) {
        break
      }
      directory = parent
    }

    throw new Error('MoNecromanCI assets directory not found')
  }
})()

/**
 * Reads a bundled asset file as UTF-8 text.
 *
 * @remarks
 * Resolves `relativePath` against {@link assetsRoot}.
 *
 * @param relativePath - Path relative to the assets root.
 * @returns The file's UTF-8 content.
 * @throws Propagates any Node.js `fs` error (e.g. file not found) raised by
 * the underlying read.
 * @typeParam None - this function has no generic type parameters.
 */
export function readAsset (relativePath: string): string {
  return readFileSync(join(assetsRoot(), relativePath), 'utf8')
}

/**
 * Lists every file under an asset directory as forward-slash relative paths.
 *
 * @remarks
 * Recurses into subdirectories; paths are normalised to forward slashes
 * regardless of platform.
 *
 * @param relativeDirectory - Directory, relative to {@link assetsRoot}, to list.
 * @returns The relative file paths found, in directory-traversal order.
 * @throws Propagates any Node.js `fs` error (e.g. directory not found) raised
 * by the underlying read.
 * @typeParam None - this function has no generic type parameters.
 */
export function listAssetFiles (relativeDirectory: string): string[] {
  const base = join(assetsRoot(), relativeDirectory)
  const files: string[] = []

  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        files.push(relative(base, full).split(sep).join('/'))
      }
    }
  }

  walk(base)
  return files
}
