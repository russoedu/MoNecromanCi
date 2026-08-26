/**
 * The `<html>` tag as `flutter create` writes it: no attributes at all.
 *
 * @remarks
 * Deliberately narrow. An `<html lang="en">` that upstream already fixed, or
 * one a user has edited to their own locale, must be left exactly as it is —
 * so this matches only the bare tag rather than any `<html ...>`.
 */
const BARE_HTML_TAG = /<html>/i

/**
 * Adds `lang="en"` to the `<html>` tag of a `flutter create` web shell.
 *
 * @remarks
 * `flutter create --platforms=web` emits `web/index.html` with a bare `<html>`
 * tag. That is an accessibility defect on its own — a screen reader has no
 * language to announce the page in — and mnci lints HTML with `@html-eslint`,
 * whose `require-lang` rule reports it as an **error**. So a freshly generated
 * Flutter app failed `npm run lint` on a file the user had never opened.
 *
 * Found by the nightly e2e, which reported it three times as
 * `eslint could not format '.' (exit code 1)` during `mnci add` — non-fatal
 * there, and therefore easy to scroll past, but a hard `npm run lint` failure
 * for anyone who generated a Flutter app.
 *
 * **Patched, not linted around.** Switching `require-lang` off would trade a
 * real a11y rule for one piece of upstream boilerplate, and ignoring the path
 * would leave the defect in every generated app's deployed bundle. The same
 * call this project made for a react-app's `nx-welcome.tsx`.
 *
 * @param contents - The current `index.html` contents.
 * @returns The contents with `lang="en"` added, or unchanged when the tag is
 * absent or already carries attributes.
 * @throws Never - pure string transformation.
 * @typeParam None - this function has no generic type parameters.
 */
export function withHtmlLang (contents: string): string {
  return contents.replace(BARE_HTML_TAG, '<html lang="en">')
}
