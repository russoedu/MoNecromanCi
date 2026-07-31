/**
 * Converts an mnci project name into a valid Dart package name.
 *
 * @remarks
 * The two naming rules genuinely differ, so this conversion is load-bearing
 * rather than cosmetic. mnci validates project names as
 * `[a-z][a-z0-9-]*(\.[a-z0-9-]+)*` (`assertValidProjectName`), which permits
 * hyphens **and dots**; Dart package names must be `lowercase_with_underscores`
 * — pub requires `[a-z_][a-z0-9_]*` and rejects anything else in the pubspec
 * outright. So `my-app` becomes `my_app`, `my.app` likewise becomes `my_app`,
 * and the Dart `import 'package:my_app/...'` follows from that.
 *
 * The Nx project name deliberately keeps the original hyphenated form: it is
 * what `nx run <name>:build` and the release tag (`{projectName}@{version}`)
 * use, and it matches every other mnci kind. Only the *Dart* identifier is
 * transformed — the same split `add/python.ts` makes for Python modules.
 *
 * @param name - The mnci project name (already validated).
 * @returns The Dart package name.
 * @throws Never - pure string transformation.
 * @typeParam None - this function has no generic type parameters.
 */
export function dartPackageName(name: string): string {
  return name.replaceAll(/[-.]/g, '_')
}
