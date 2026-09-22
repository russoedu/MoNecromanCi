/**
 * Reads the rollup config a generated library actually builds with, following the
 * `require()` chain into any shared base config it delegates to.
 *
 * @remarks
 * A project's own `rollup.config.cjs` is not always the whole story: the
 * generators emit configs that `require()` a workspace-level base, so a check
 * reading only the project file reports a repair as missing when it is simply
 * one file further out. This is the read side of the slice; the transforms it
 * feeds live in `rollup-config.algorithm.ts`.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileExists } from '../file-system'

/**
 * Resolves a relative `require()` specifier to a real file.
 *
 * @remarks
 * Tries the specifier as given first, then the extensions a `.cjs` rollup
 * config (or a shared base it delegates to) is realistically written with -
 * `require()` itself resolves the same way, this just needs to agree with it
 * without actually loading the module.
 *
 * @param fromDir - The directory the `require()` call is made from.
 * @param specifier - The relative specifier passed to `require()`.
 * @returns The resolved absolute path, or `undefined` when none of the
 *   candidates exist.
 * @throws Never - only checks the filesystem.
 * @typeParam None - this function has no generic type parameters.
 */
function resolveRequireTarget (fromDir: string, specifier: string): string | undefined {
  const base = join(fromDir, specifier)

  return [base, `${base}.cjs`, `${base}.js`].find(candidate => fileExists(candidate))
}

/**
 * Reads a rollup config's text, following local `require()` delegation so a
 * config hoisted into a shared base file is read as if it were inlined.
 *
 * @remarks
 * A workspace that pulls the `withNx(...)` call out into one root
 * `rollup.base.cjs` and leaves each project as
 * `module.exports = require('../../rollup.base.cjs')()` has no
 * `sourceMap: true` text of its own to find - {@link hasRollupSourceMaps}
 * reading only the project's own file would report every such project as
 * missing source maps even when every one genuinely has them, because the
 * flag lives one file away. Text-based rather than an actual `require()` of
 * the config, deliberately: `mnci doctor` is read-only, and evaluating a
 * user's build config as code to answer a yes/no question is a far larger
 * blast radius than reading more of its text.
 *
 * Only RELATIVE requires (`./…`, `../…`) are followed - an npm package's
 * installed source (e.g. `@nx/rollup/with-nx`) is never something this needs
 * to read, and grepping into node_modules would be both slow and pointless.
 * Each file is read at most once, so a require cycle terminates rather than
 * recursing forever.
 *
 * @param configPath - Absolute path to the rollup config being inspected.
 * @param visited - File paths already read, to stop a require cycle. Callers
 *   should omit this; it is populated by recursive calls.
 * @returns The config's own text, followed by the text of every local file it
 *   `require()`s, transitively.
 * @throws Never - an unreadable file or unresolvable require target is skipped.
 * @typeParam None - this function has no generic type parameters.
 */
export function resolveRollupConfigText (
  configPath: string,
  visited: Set<string> = new Set(),
): string {
  if (visited.has(configPath)) {
    return ''
  }
  visited.add(configPath)

  let text: string
  try {
    text = readFileSync(configPath, 'utf8')
  } catch {
    return ''
  }

  const specifiers = Array.from(
    text.matchAll(/require\((['"])(\.[^'"]*)\1\)/g),
    match => match[2],
  )
  const requiredText = specifiers
    .map(specifier => resolveRequireTarget(dirname(configPath), specifier))
    .filter((target): target is string => target !== undefined)
    .map(target => resolveRollupConfigText(target, visited))

  return [text, ...requiredText].join('\n')
}
