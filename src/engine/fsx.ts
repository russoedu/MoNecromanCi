import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Creates a directory (and parents) if it does not already exist. */
export function ensureDirectory (directory: string): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true })
  }
}

/** Writes a UTF-8 file, creating parent directories as needed. */
export function writeFileEnsured (filePath: string, content: string): void {
  ensureDirectory(dirname(filePath))
  writeFileSync(filePath, content, 'utf8')
}

/** Reads and parses a JSON file, returning `fallback` (or `undefined`) on any error. */
export function readJsonSafe<T> (filePath: string): T | undefined
export function readJsonSafe<T> (filePath: string, fallback: T): T
export function readJsonSafe<T> (filePath: string, fallback?: T): T | undefined {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Returns the trimmed text content of a file, or an empty string. */
export function readTextSafe (filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

/** Serialises a value as pretty-printed JSON with a trailing newline. */
export function toJson (value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`
}

export { existsSync as fileExists } from 'node:fs'
