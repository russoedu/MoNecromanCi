import spawn from 'cross-spawn'

/**
 * The result of one Flutter CLI invocation.
 *
 * @remarks
 * `output` merges stdout and stderr, because flutter writes diagnostics to both
 * and a caller building an error message wants all of it.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface FlutterResult {
  /** Whether the command exited 0. */
  ok: boolean
  /** stdout and stderr, merged and trimmed. */
  output: string
  /** A one-line explanation suitable for appending to an error message. */
  reason: string
}

/**
 * Runs the Flutter CLI, capturing everything it says.
 *
 * @remarks
 * **Uses `cross-spawn`, and that is the fix rather than a preference.** On
 * Windows the SDK ships `flutter.bat`, and since the fix for CVE-2024-27980
 * (Node 18.20.2 / 20.12.0 / 21.7.3) `child_process.spawnSync` **refuses to
 * execute a `.bat` or `.cmd` at all** without `shell: true`. It does not throw:
 * it returns `{ error, status: null, stdout: null }`.
 *
 * This package used to call `spawnSync` directly on the strength of a comment
 * saying that naming `flutter.bat` explicitly "keeps every `spawnSync` call
 * cross-platform without `shell: true`". That was true once and is now exactly
 * backwards — it made every Flutter invocation fail on Windows before the
 * process started. The symptom was maximally unhelpful: `status ?? 1` reported
 * "exit code 1" while stdout and stderr were empty, so the thrown error said
 * `failed with exit code 1` and `(no output)`, and Nx's own wrapper suggested
 * checking whether the SDK was on PATH. It was on PATH, and had printed its
 * version seconds earlier.
 *
 * `cross-spawn` resolves `.bat`/`.cmd` shims correctly **without** a shell, so
 * it fixes the failure without reintroducing the argument-quoting hazard that
 * comment was right to worry about. It is the same library the CLI uses, for
 * this same reason.
 *
 * **`result.error` is reported.** Not reading it is what made a spawn that never
 * started indistinguishable from a command that ran and failed — two very
 * different problems with one message. Capturing stdout/stderr alone did not fix
 * that, which a previous attempt at this discovered the hard way.
 *
 * @param arguments_ - Arguments to pass to `flutter`.
 * @param cwd - Working directory for the invocation.
 * @returns Whether it succeeded, everything it printed, and a reason on failure.
 * @throws Never - a failure is reported in the return value.
 * @typeParam None - this function has no generic type parameters.
 */
export function runFlutter (arguments_: string[], cwd: string): FlutterResult {
  const result = spawn.sync('flutter', arguments_, { cwd, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (output) console.log(output)

  if (result.error) {
    return {
      ok: false,
      output,
      reason: `could not start the Flutter CLI (${result.error.message}). Is the Flutter SDK on your PATH? https://docs.flutter.dev/get-started/install`
    }
  }

  return {
    ok: result.status === 0,
    output,
    reason:
      result.status === 0
        ? ''
        : `exited with code ${result.status ?? 'unknown'}.\nflutter said:\n${output || '(no output)'}`
  }
}
