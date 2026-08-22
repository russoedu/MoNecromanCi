/**
 * Resolves the Python executable name for the current platform.
 *
 * @remarks
 * Shared by every executor and {@link versionActions} in this package, so
 * they all invoke the same binary a given machine actually has. POSIX
 * systems (Linux/macOS — the assumed default) register `python3`; the
 * standard python.org Windows installer registers only `python.exe`, not
 * `python3.exe`, so a hard-coded `python3` fails outright there with
 * "'python3' is not recognized as an internal or external command." This is
 * a static, zero-cost platform check (`process.platform`), not a subprocess
 * probe — every executor call site would otherwise need its own probing
 * logic, or silently assume POSIX.
 *
 * @param None - this function takes no parameters.
 * @returns `'python'` on `win32`, `'python3'` everywhere else.
 * @throws Never - pure platform check.
 * @typeParam None - this function has no generic type parameters.
 */
export function pythonCommand (): string {
  return process.platform === 'win32' ? 'python' : 'python3'
}
