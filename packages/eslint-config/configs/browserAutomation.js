import globals from 'globals'

/**
 * Browser globals for in-page callbacks, for Playwright and Puppeteer projects.
 *
 * `page.evaluate(() => document.body.scrollHeight)` fails `mnci/base` with:
 *
 * ```
 * Variable document not defined in scope of isolated function.
 * Function is isolated because: callee of method named "page.evaluate"
 * ```
 *
 * `unicorn/isolated-functions` is right about the isolation - that callback is
 * serialised and run inside the page, so it genuinely cannot see anything from
 * the enclosing module - and it checks every free variable against the
 * declared globals. The default globals here are Node's, because that is what
 * the surrounding file runs in. So no browser global exists for the callback
 * and every one of them reports.
 *
 * Without this, a browser-automation project has three bad options: pass string
 * scripts instead of functions and lose type checking entirely, disable a rule
 * that is otherwise catching real scope bugs, or leave `npm run lint` red.
 *
 * WHAT THIS DOES NOT DO
 *
 * It declares browser globals; it does not make them true. A file in this
 * scope may now reference `document` at the TOP level without ESLint objecting,
 * and that would throw at run time in Node. TypeScript is the check that still
 * catches it - `document` is not in scope unless the project's `lib` includes
 * `dom` - which is why this is scoped by glob and opt-in rather than on by
 * default.
 *
 * @param files - Globs the browser globals apply to. Default: every project's
 * `src` under `apps/`, `libs/` and `packages/`.
 * @returns The flat config block.
 */
export default function browserAutomation (files = [
  'apps/*/src/**/*.{ts,mts,cts,tsx}',
  'libs/*/src/**/*.{ts,mts,cts,tsx}',
  'packages/*/src/**/*.{ts,mts,cts,tsx}',
]) {
  return [
    {
      name:            'mnci/browser-automation',
      files,
      languageOptions: { globals: { ...globals.browser } },
    },
  ]
}
