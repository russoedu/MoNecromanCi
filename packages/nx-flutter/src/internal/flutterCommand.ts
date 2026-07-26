/**
 * The Flutter CLI executable name for the current platform.
 *
 * @remarks
 * On Windows the SDK ships `flutter.bat`, not a bare `flutter`; resolving it
 * here keeps every `spawnSync` call in this package cross-platform without
 * `shell: true` (which would reintroduce the argument-quoting hazard the CLI
 * deliberately avoids by using `cross-spawn`). Mirrors `pythonCommand()` in
 * `@mnci/nx-python-pip`, which resolves `python` vs `python3` the same way.
 *
 * @param None - this function takes no parameters.
 * @returns `flutter.bat` on Windows, otherwise `flutter`.
 * @throws Never - reads `process.platform`.
 * @typeParam None - this function has no generic type parameters.
 */
export function flutterCommand(): string {
  return process.platform === 'win32' ? 'flutter.bat' : 'flutter'
}
