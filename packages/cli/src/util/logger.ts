/**
 * Minimal namespaced console logger used across the CLI.
 *
 * @remarks
 * Each method prefixes `message` with a small glyph to distinguish severity
 * when scanning terminal output.
 */
export const logger = {
  info (message: string): void {
    console.log(message)
  },
  step (message: string): void {
    console.log(`→ ${message}`)
  },
  success (message: string): void {
    console.log(`✓ ${message}`)
  },
  warn (message: string): void {
    console.warn(`! ${message}`)
  },
  error (message: string): void {
    console.error(`✗ ${message}`)
  },
}
