// @mnci/nx-python-pip has no runtime entry point of its own — everything is
// resolved through generators.json/executors.json (Nx's own plugin
// discovery) and the ./release/version-actions export. This file exists
// only so `package.json`'s `main`/`types` fields resolve to something.
/**
 * Placeholder export, so this module is a real ES module.
 *
 * @remarks
 * Deliberately not the bare `export {}` marker: that form is TypeScript-only
 * syntax, and lint rules reject an export statement carrying no specifiers.
 * Nothing consumes this — `@mnci/nx-python-pip` is resolved entirely through
 * `generators.json`/`executors.json` and the `./release/version-actions`
 * export.
 */
export const plugin = {}
