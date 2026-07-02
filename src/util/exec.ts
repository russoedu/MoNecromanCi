import { spawnSync } from 'node:child_process'

/**
 * Runs a command synchronously, inheriting stdio so its output streams live.
 *
 * @remarks
 * Used by the `validate`/`ritual` command to shell out to the repo's local Nx.
 * `shell: true` lets Windows resolve `npx` (a `.cmd` shim) without an explicit
 * extension. The command and arguments are joined into one line rather than
 * passed as an args array (which, combined with `shell: true`, triggers Node's
 * DEP0190); our argument tokens contain no spaces or shell metacharacters.
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
