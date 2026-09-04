import spawn from 'cross-spawn'
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
export function runShell (command: string, arguments_: string[], cwd: string): number {
  const result = spawn.sync(command, arguments_, { stdio: 'inherit', cwd })
  return result.status ?? 1
}

/**
 * The captured outcome of a command run through {@link runCapture}.
 *
 * @remarks
 * `stdout` is always a string — never `null` — so callers can parse it without
 * a nullish guard at every site. A spawn that never started yields status `1`
 * and an empty string, which is indistinguishable from a command that failed
 * silently; that is deliberate, because every caller here treats both as "no
 * answer available" rather than branching on the difference.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface CaptureResult {
  /** The child process exit status; `1` when it never produced one. */
  status: number
  /** Everything the child wrote to stdout, decoded as UTF-8. */
  stdout: string
}

/**
 * How long a captured command may run before it is killed, in milliseconds.
 *
 * @remarks
 * Generous compared with the update checker's 2s registry budget, because the
 * commands routed through here are not all network calls: the Go and Dart
 * "what is outdated" queries each resolve a whole dependency graph, and a cold
 * `flutter pub` run on a large workspace genuinely takes tens of seconds. A
 * timeout tuned for a single registry lookup would abort those before they ever
 * answered.
 */
const CAPTURE_TIMEOUT_MS = 60_000

/**
 * Runs a command and captures its stdout instead of streaming it.
 *
 * @remarks
 * The counterpart to {@link runShell}, which inherits stdio and therefore hands
 * the caller nothing but an exit code. Commands whose *output* is the answer —
 * `npm view`, `go list -m -u -json all`, `flutter pub outdated --json` — need
 * this one.
 *
 * Same `cross-spawn` argv-array contract as {@link runShell}, for the same
 * reason: no shell interprets the arguments, so a package name originating from
 * a manifest can never be executed. `execSync` with a shell string would
 * reintroduce exactly the injection hazard `runShell`'s docblock describes, and
 * its POSIX-only redirection would fail outright on a Windows agent.
 *
 * stderr is discarded (`'ignore'`) rather than piped: every caller parses
 * stdout, and npm in particular writes progress and audit noise to stderr that
 * would otherwise have to be filtered out at each site. A failing command is
 * detected by its status, not by what it printed.
 *
 * @param command - The executable to run (e.g. `npm`).
 * @param arguments_ - The arguments passed to the executable.
 * @param cwd - The working directory to run the command in.
 * @returns The exit status and the captured stdout.
 * @throws Never - a spawn failure or timeout surfaces as a non-zero status.
 * @typeParam None - this function has no generic type parameters.
 */
export function runCapture (command: string, arguments_: string[], cwd: string): CaptureResult {
  const result = spawn.sync(command, arguments_, {
    cwd,
    encoding: 'utf8',
    timeout: CAPTURE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  // `result.error` covers the spawn that never started (an absent toolchain,
  // most often) — there `status` is null and stdout is null too.
  if (result.error) {
    return { status: 1, stdout: '' }
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '' }
}

/**
 * Runs a command asynchronously and captures its stdout.
 *
 * @remarks
 * The async twin of {@link runCapture}, and it exists for exactly one reason:
 * `mnci up` asks the registry about every declared package, and a synchronous
 * spawn per package makes that a serial wait of roughly half a second times the
 * dependency count — half a minute on a workspace of any size. Callers pool
 * these, so the same work overlaps.
 *
 * Same argv-array, no-shell contract as every other helper here. The promise
 * never rejects: a spawn error resolves as status `1` with empty output, so a
 * pool of these needs no per-item `catch` and one absent toolchain cannot take
 * the whole run down.
 *
 * @param command - The executable to run.
 * @param arguments_ - The arguments passed to the executable.
 * @param cwd - The working directory to run the command in.
 * @returns A promise of the exit status and captured stdout.
 * @throws Never - failures resolve as a non-zero status.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runCaptureAsync (
  command: string,
  arguments_: string[],
  cwd: string
): Promise<CaptureResult> {
  return await new Promise<CaptureResult>(resolve => {
    const child = spawn(command, arguments_, {
      cwd,
      timeout: CAPTURE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    let stdout = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', () => {
      resolve({ status: 1, stdout: '' })
    })
    child.on('close', code => {
      resolve({ status: code ?? 1, stdout })
    })
  })
}

/**
 * Runs an async job over every input, at most `limit` at a time.
 *
 * @remarks
 * A pool rather than `Promise.all` over the whole list: a workspace can declare
 * a hundred packages, and spawning a hundred `npm view` processes at once is
 * how a laptop runs out of file descriptors and a CI agent starts timing out.
 * Results come back in input order regardless of completion order, so a report
 * built from them is deterministic.
 *
 * @param items - The inputs to process.
 * @param limit - Maximum number of jobs in flight at once.
 * @param job - The work to run for one input.
 * @returns A promise of the results, in the same order as `items`.
 * @throws Propagates the first rejection from `job`.
 * @typeParam TIn - The input element type.
 * @typeParam TOut - The result element type.
 */
export async function pool<TIn, TOut> (
  items: readonly TIn[],
  limit: number,
  job: (item: TIn) => Promise<TOut>
): Promise<TOut[]> {
  const results: TOut[] = Array.from({ length: items.length })
  let next = 0

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await job(items[index])
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => await worker()))
  return results
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

/**
 * Runs the workspace's formatter over a freshly generated workspace or project.
 *
 * @remarks
 * Nx's own generators emit semicolons, double quotes and trailing commas —
 * the opposite of the JavaScript Standard Style mnci configures. Without this
 * pass a workspace fails its own `lint` the moment it is created, which is a
 * poor first impression and, worse, buries every real formatting change under a
 * wall of generator noise on the first commit. Running it here means what mnci
 * hands back is already normalised.
 *
 * **There is no formatter to choose any more, and that is what makes this
 * safe.** This function used to take the workspace's linter choice and pick a
 * binary from it, because getting that wrong was a real bug: running
 * `npx prettier --write .` in a workspace with no Prettier config does not
 * fail, it silently reformats everything against its own defaults — semicolons, double
 * quotes, trailing commas — over files mnci had just written correctly. Now
 * ESLint is the only tool, so the config that decides the style and the binary
 * that applies it cannot disagree: there is only one of each.
 *
 * The ignore list comes from `eslint.config.mjs` for the same reason, rather
 * than from a separate `.prettierignore` that a second tool had to be taught to
 * read.
 *
 * Deliberately non-fatal. The project has already been generated and wired by
 * the time this runs; aborting on a formatter hiccup would leave a usable
 * workspace behind an error message. A warning names the exact command to
 * re-run instead.
 *
 * @param cwd - The workspace root to run in.
 * @param target - What to format, relative to `cwd`. Defaults to the whole
 * workspace (`.`); `add` passes the new project's root to keep the pass
 * proportional to what actually changed.
 * @returns Nothing.
 * @throws Never - a non-zero exit is reported as a warning.
 * @typeParam None - this function has no generic type parameters.
 */
export function runFormatter (cwd: string, target = '.'): void {
  // ESLint IS the formatter now, so formatting a generated project is
  // `eslint --fix` rather than a separate binary. Nx's generators emit
  // semicolons and double quotes, so without this pass a fresh workspace fails
  // its own `lint` before the user has written a line.
  //
  // No `--cache` here: this runs once on freshly written files, where a cache
  // can only cost a write. The lint TARGETS carry it, which is where repeat
  // runs actually happen.
  const status = runShell('npx', ['eslint', target, '--fix'], cwd)
  if (status !== 0) {
    logger.warn(
      `eslint could not format '${target}' (exit code ${status}). ` +
        "The project was generated; run 'npm run format' to normalise it."
    )
  }
}
