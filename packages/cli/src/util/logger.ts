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
  /**
   * A sub-step under the most recent {@link logger.step}, indented to read as detail.
   *
   * `this: void` because this one is handed to `applyOverlay` as a progress callback,
   * detached from the object. It reads no instance state, and the annotation is what
   * says so — without it every such call is an unbound-method error.
   */
  detail (this: void, message: string): void {
    console.log(`   · ${message}`)
  },
  success (message: string): void {
    console.log(`✓ ${message}`)
  },
  warn (message: string): void {
    console.warn(`! ${message}`)
  },
  error (message: string): void {
    console.error(`✗ ${message}`)
  }
}
