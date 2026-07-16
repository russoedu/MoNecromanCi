import { spawnSync } from 'node:child_process'

/**
 * Runs a command synchronously, inheriting stdio so its output streams live.
 *
 * @remarks
 * v2 shells out for everything — `create-nx-workspace`, `nx add`, `nx g` — so
 * the CLI stays version-decoupled from whatever Nx is current, and the plugin
 * generators' own interactive output reaches the user unmodified. `shell: true`
 * lets Windows resolve `npx` (a `.cmd` shim) without an explicit extension.
 * The command and arguments are joined into one line rather than passed as an
 * args array (which, combined with `shell: true`, triggers Node's DEP0190);
 * every token we pass is quoted by {@link quote} where it could contain spaces.
 *
 * @param command - The executable to run (e.g. `npx`).
 * @param arguments_ - The arguments passed to the executable.
 * @param cwd - The working directory to run the command in.
 * @returns The child process exit status (`0` on success); `1` when the process
 * was terminated by a signal or never produced a status (e.g. spawn failure).
 * @throws Never - spawn failures surface through the returned status, not a throw.
 * @typeParam None - this function has no generic type parameters.
 */
export function runShell (command: string, arguments_: string[], cwd: string): number {
  const line = [command, ...arguments_].join(' ')
  const result = spawnSync(line, { stdio: 'inherit', shell: true, cwd })
  return result.status ?? 1
}

/**
 * Wraps a value in double quotes for safe inclusion in a shell line.
 *
 * @remarks
 * Only needed for tokens that may contain spaces (e.g. the Azure Functions
 * template name `"HTTP trigger"`). Rejects embedded double quotes outright
 * rather than trying to escape them — no legitimate project name or template
 * contains one.
 *
 * @param value - The raw token.
 * @returns The token wrapped in double quotes.
 * @throws Error when the value itself contains a double quote.
 * @typeParam None - this function has no generic type parameters.
 */
export function quote (value: string): string {
  if (value.includes('"')) {
    throw new Error(`Refusing to shell-quote a value containing a double quote: ${value}`)
  }
  return `"${value}"`
}

/**
 * Runs `npx nx <args>` in the given workspace, failing loudly on error.
 *
 * @remarks
 * Every generator/plugin invocation funnels through here so tests can assert
 * the exact delegation and the error contract stays in one place.
 *
 * @param arguments_ - The Nx CLI arguments (e.g. `['g', '@nx/react:app', …]`).
 * @param cwd - The workspace root to run in.
 * @returns Nothing. Throws instead of returning a status.
 * @throws Error when the Nx process exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
export function runNx (arguments_: string[], cwd: string): void {
  const status = runShell('npx', ['nx', ...arguments_], cwd)
  if (status !== 0) {
    throw new Error(`nx ${arguments_.join(' ')} failed with exit code ${status}`)
  }
}

/**
 * Runs `npx <args>` in the given directory, failing loudly on error.
 *
 * @remarks
 * Used for the one non-Nx invocation: `create-nx-workspace` itself, which by
 * definition runs *outside* any workspace.
 *
 * @param arguments_ - The npx arguments (e.g. `['create-nx-workspace@latest', …]`).
 * @param cwd - The directory to run in.
 * @returns Nothing. Throws instead of returning a status.
 * @throws Error when the process exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
export function runNpx (arguments_: string[], cwd: string): void {
  const status = runShell('npx', arguments_, cwd)
  if (status !== 0) {
    throw new Error(`npx ${arguments_.join(' ')} failed with exit code ${status}`)
  }
}
