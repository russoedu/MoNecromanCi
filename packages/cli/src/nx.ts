import spawn from 'cross-spawn'

/**
 * Runs a command synchronously, inheriting stdio so its output streams live.
 *
 * @remarks
 * Shells out for everything — `create-nx-workspace`, `nx add`, `nx g` — so
 * the CLI stays version-decoupled from whatever Nx is current, and the plugin
 * generators' own interactive output reaches the user unmodified.
 *
 * Uses `cross-spawn` (not `node:child_process`'s `spawnSync` with
 * `shell: true`) specifically so arguments are never interpreted by a shell:
 * `cross-spawn` is a drop-in `spawnSync` replacement that resolves Windows
 * `.cmd`/`.bat` shims itself, safely, from the `(command, args, options)`
 * array form — no string concatenation, so a value containing shell
 * metacharacters (semicolons, backticks, `$()`, …) is passed through as one
 * literal argv entry, never executed. Every argument we pass (workspace/
 * project name, scope, Azure coordinates, …) can originate from user input, so
 * this matters: the previous `[command, ...args].join(' ')` + `shell: true`
 * design let a crafted name run arbitrary shell commands.
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
  const result = spawn.sync(command, arguments_, { stdio: 'inherit', cwd })
  return result.status ?? 1
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
