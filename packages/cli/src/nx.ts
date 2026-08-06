import spawn from 'cross-spawn'
import type { LinterChoice } from './overlay'
import { logger } from './util/logger'

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
export function runShell(command: string, arguments_: string[], cwd: string): number {
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
export function runNx(arguments_: string[], cwd: string): void {
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
export function runNpx(arguments_: string[], cwd: string): void {
  const status = runShell('npx', arguments_, cwd)
  if (status !== 0) {
    throw new Error(`npx ${arguments_.join(' ')} failed with exit code ${status}`)
  }
}

/**
 * Runs the workspace's formatter over a freshly generated workspace or project.
 *
 * @remarks
 * Nx's own generators emit semicolons, double quotes and trailing commas —
 * the opposite of the JavaScript Standard Style mnci configures. Without this
 * pass a workspace fails its own `npm run format:check` the moment it is
 * created, which is a poor first impression and, worse, buries every real
 * formatting change under a wall of generator noise on the first commit.
 * Running it here means what mnci hands back is already normalised.
 *
 * **Which formatter is not a detail, and hardcoding Prettier here was a real
 * bug.** An oxlint workspace has no `.prettierrc.mjs` — the overlay deletes it
 * — so `npx prettier --write .` there does not fail, it silently formats the
 * whole workspace against **Prettier's own defaults**: semicolons, double
 * quotes, trailing commas. The exact opposite of the shared opinion, applied to
 * files mnci itself had just written correctly. `oxfmt --check` then reported
 * 19 files unformatted in a freshly generated workspace, `eslint.config.mjs`
 * and `oxlint.config.ts` among them. Caught by the real e2e; no fixture could
 * have, since it needs a generated workspace with both configs in play.
 *
 * `.prettierignore` (written by the overlay) keeps this off `node_modules`,
 * build output and lockfiles, and oxfmt reads that same file by default — so
 * the pass stays cheap either way, with one ignore list rather than two.
 *
 * Deliberately non-fatal. The project has already been generated and wired by
 * the time this runs; aborting on a formatter hiccup would leave a usable
 * workspace behind an error message. A warning names the exact command to
 * re-run instead.
 *
 * @param cwd - The workspace root to run in.
 * @param linter - The workspace's linter choice, which picks the formatter:
 * `eslint` pairs with Prettier, `oxlint` with oxfmt.
 * @param target - What to format, relative to `cwd`. Defaults to the whole
 * workspace (`.`); `add` passes the new project's root to keep the pass
 * proportional to what actually changed.
 * @returns Nothing.
 * @throws Never - a non-zero exit is reported as a warning.
 * @typeParam None - this function has no generic type parameters.
 */
export function runFormatter(cwd: string, linter: LinterChoice, target = '.'): void {
  // `--write` is oxfmt's default, but it is passed explicitly so the intent
  // survives a future change of that default — this call REWRITES a user's
  // files, which is not something to leave implicit.
  const [command, arguments_] =
    linter === 'oxlint'
      ? ['oxfmt', ['--write', target]]
      : ['prettier', ['--write', '--log-level', 'warn', target]]
  const status = runShell('npx', [command, ...arguments_], cwd)
  if (status !== 0) {
    logger.warn(
      `${command} could not format '${target}' (exit code ${status}). ` +
        "The project was generated; run 'npm run format' to normalise it."
    )
  }
}
