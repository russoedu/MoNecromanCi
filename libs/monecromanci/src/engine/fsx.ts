import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Creates a directory (and parents) if it does not already exist.
 *
 * @remarks
 * No-op when the directory is already present.
 *
 * @param directory - Absolute path to ensure exists.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error (e.g. permission denied) raised
 * by the underlying `mkdirSync` call.
 * @typeParam None - this function has no generic type parameters.
 */
export function ensureDirectory (directory: string): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true })
  }
}

/**
 * Writes a UTF-8 file, creating parent directories as needed.
 *
 * @remarks
 * Delegates directory creation to {@link ensureDirectory}.
 *
 * @param filePath - Absolute path of the file to write.
 * @param content - UTF-8 text content to write.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error (e.g. permission denied) raised
 * by the underlying write.
 * @typeParam None - this function has no generic type parameters.
 */
export function writeFileEnsured (filePath: string, content: string): void {
  ensureDirectory(dirname(filePath))
  writeFileSync(filePath, content, 'utf8')
}

/**
 * Deletes a file or directory if it exists; a no-op otherwise.
 *
 * @remarks
 * Used by `doctor` to clean up root paths a prior template version generated
 * but the current one no longer produces.
 *
 * @param path - Absolute path of the file or directory to remove.
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error (e.g. permission denied) raised
 * by the underlying `rmSync` call.
 * @typeParam None - this function has no generic type parameters.
 */
export function removeFileIfExists (path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true })
  }
}

/**
 * Reads and parses a JSON file as `T`.
 *
 * @remarks
 * Overload: returns `undefined` when the file is missing or invalid (no
 * fallback supplied).
 *
 * @param filePath - Absolute path to the JSON file.
 * @param fallback - Not provided in this overload.
 * @returns The parsed value, or `undefined` on any error.
 * @throws Never - read and parse errors are caught and `undefined` returned.
 * @typeParam T - The shape of the expected parsed value.
 */
export function readJsonSafe<T> (filePath: string): T | undefined
/**
 * Reads and parses a JSON file as `T`, falling back to `fallback` on any error.
 *
 * @remarks
 * Overload: always returns a value of type `T`.
 *
 * @param filePath - Absolute path to the JSON file.
 * @param fallback - Value returned when the file is missing or invalid.
 * @returns The parsed value, or `fallback` on any error.
 * @throws Never - read and parse errors are caught and `fallback` returned.
 * @typeParam T - The shape of the expected parsed value.
 */
export function readJsonSafe<T> (filePath: string, fallback: T): T
/**
 * Implementation for the {@link readJsonSafe} overloads above.
 *
 * @remarks
 * Catches all read/parse errors and returns `fallback` (or `undefined`).
 *
 * @param filePath - Absolute path to the JSON file.
 * @param fallback - Value returned when the file is missing or invalid.
 * @returns The parsed value, or `fallback`/`undefined` on any error.
 * @throws Never - read and parse errors are caught and replaced by `fallback`.
 * @typeParam T - The shape of the expected parsed value.
 */
export function readJsonSafe<T> (filePath: string, fallback?: T): T | undefined {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

/**
 * Returns the trimmed text content of a file, or an empty string.
 *
 * @remarks
 * Swallows all read errors (e.g. file not found) and returns `''` instead.
 *
 * @param filePath - Absolute path to the file to read.
 * @returns The file's UTF-8 content, or `''` on any error.
 * @throws Never - read errors are caught and an empty string returned.
 * @typeParam None - this function has no generic type parameters.
 */
export function readTextSafe (filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Normalises CRLF line endings to LF.
 *
 * @remarks
 * Used to compare tool-owned file content without treating a pure
 * line-ending difference (e.g. a file edited on Windows) as real drift.
 *
 * @param text - The text to normalise.
 * @returns The text with every `\r\n` replaced by `\n`.
 * @throws Never - performs no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function normalizeEol (text: string): string {
  return text.replaceAll('\r\n', '\n')
}

/**
 * Serialises a value as pretty-printed JSON with a trailing newline.
 *
 * @remarks
 * Uses a 2-space indent to match the project's formatting conventions.
 *
 * @param value - The value to serialise.
 * @returns The JSON string, terminated with `\n`.
 * @throws Propagates any error `JSON.stringify` raises (e.g. circular references).
 * @typeParam None - this function has no generic type parameters.
 */
export function toJson (value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`
}

export { existsSync as fileExists } from 'node:fs'
