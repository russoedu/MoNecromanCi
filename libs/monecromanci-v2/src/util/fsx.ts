import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Reads and parses a JSON file.
 *
 * @remarks
 * No safety net by design: a missing or malformed file is a real error the
 * caller should see, not silently default away.
 *
 * @param path - Absolute path to the JSON file.
 * @returns The parsed value, typed by the caller.
 * @throws Propagates any Node.js `fs` error (e.g. file not found) or JSON
 * parse error raised by the underlying read.
 * @typeParam T - The expected shape of the parsed JSON.
 */
export function readJson<T> (path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/**
 * Serialises a value as 2-space-indented JSON with a trailing newline.
 *
 * @remarks
 * Matches the formatting `create-nx-workspace` itself emits, so patched files
 * stay diff-friendly.
 *
 * @param value - The value to serialise.
 * @returns The JSON text.
 * @throws Propagates any `JSON.stringify` error (e.g. circular references).
 * @typeParam None - this function has no generic type parameters.
 */
export function toJson (value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`
}

/**
 * Writes a file, creating any missing parent directories first.
 *
 * @remarks
 * Used for every overlay write, so callers never worry about directory
 * existence (e.g. `.husky/` on a fresh workspace).
 *
 * @param path - Absolute path to write.
 * @param content - The file content.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error (e.g. permission denied).
 * @typeParam None - this function has no generic type parameters.
 */
export function writeFileEnsured (path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/**
 * Marks a file as executable (0o755) — used for git hooks.
 *
 * @remarks
 * Git only runs hooks with the executable bit set; a plain write loses it.
 *
 * @param path - Absolute path of the file to mark.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error (e.g. file not found).
 * @typeParam None - this function has no generic type parameters.
 */
export function markExecutable (path: string): void {
  chmodSync(path, 0o755)
}

/**
 * Replaces the first regex match in a file, failing loudly if not found.
 *
 * @remarks
 * For the handful of generator-written config files (`vite.config.mts`,
 * `rollup.config.cjs`) that have no CLI flag for their output path, so the
 * only way to redirect it is a targeted edit of the file the generator
 * itself wrote. Throwing when `pattern` doesn't match — rather than silently
 * no-op-ing — turns a future generator-output format change into a clear,
 * immediate error instead of a build silently landing in the wrong place.
 *
 * @param path - Absolute path to the file to edit.
 * @param pattern - The regex to match (first match only).
 * @param replacement - The literal text to substitute in.
 * @returns Nothing.
 * @throws Error when `pattern` does not match the file's contents.
 * @typeParam None - this function has no generic type parameters.
 */
export function replaceInFile (path: string, pattern: RegExp, replacement: string): void {
  const content = readFileSync(path, 'utf8')
  if (!pattern.test(content)) {
    throw new Error(`replaceInFile: pattern ${pattern.source} not found in ${path}`)
  }
  writeFileSync(path, content.replace(pattern, () => replacement))
}

/**
 * Whether a path exists on disk.
 *
 * @remarks
 * Thin wrapper kept for symmetry with the other helpers (and mockability).
 *
 * @param path - Absolute path to test.
 * @returns `true` when the path exists.
 * @throws Never - `existsSync` swallows errors.
 * @typeParam None - this function has no generic type parameters.
 */
export function fileExists (path: string): boolean {
  return existsSync(path)
}
