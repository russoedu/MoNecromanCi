import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

let cachedRoot: string | undefined

/**
 * Resolves the bundled `assets/` directory. Works both from `dist/` (after
 * build, where assets sit beside the bundle) and from `src/` during tests by
 * walking up until an `assets` directory is found.
 */
export function assetsRoot (): string {
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

  throw new Error('nx-magic assets directory not found')
}

/** Reads a bundled asset file as UTF-8 text. */
export function readAsset (relativePath: string): string {
  return readFileSync(join(assetsRoot(), relativePath), 'utf8')
}

/** Lists every file under an asset directory as forward-slash relative paths. */
export function listAssetFiles (relativeDirectory: string): string[] {
  const base = join(assetsRoot(), relativeDirectory)
  const files: string[] = []

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
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
