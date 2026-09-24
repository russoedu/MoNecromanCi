import { globSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
// Namespace import — see the note in configs/json.js.
import * as jsoncParser from 'jsonc-eslint-parser'

// `@nx/eslint-plugin` owns the `@nx/dependency-checks` rule, so the plugin has
// to be registered here — the old per-project config got it for free by
// spreading Nx's own generated root config, which this replaces.
//
// Resolved optionally and synchronously (a static ESM import would hard-fail
// the entire config for a non-Nx consumer, and a dynamic import would force
// the whole config to become async). Its version has to track the workspace's
// own Nx version, which is why it is a peerDependency rather than a dependency.
const require = createRequire(import.meta.url)
// The ESLint plugin object, or undefined when Nx is not installed.
let nxPlugin
try {
  nxPlugin = require('@nx/eslint-plugin')
} catch {
  nxPlugin = undefined
}

/**
 * `@nx/dependency-checks` for publishable packages, applied from the ROOT config.
 *
 * This used to be a per-project `eslint.config.mjs` that mnci wrote into every
 * `packages/<name>` (`NPM_LIB_ESLINT_CONFIG`). It lives here instead so a
 * generated workspace has exactly one ESLint config. Verified empirically that
 * the rule resolves the owning project from the linted `package.json`'s path
 * and that the projectRoot tokens still expand correctly from the root.
 *
 * TWO OF THE RULE'S THREE CHECKS ARE OFF, AND THIS IS THE IMPORTANT PART
 *
 * `@nx/dependency-checks` is fixable, and `npm run format` is
 * `eslint . --fix`. Two of its checks have fixers that DELETE or REWRITE a
 * published package's manifest:
 *
 * - `checkObsoleteDependencies` reports a declared dependency the project graph
 *   does not see used, and its fixer calls `removeRange` on the property.
 * - `checkVersionMismatches` reports a range that does not contain the
 *   installed version, and its fixer calls `replaceText` with the exact
 *   version — turning `"^4.6.5"` into `"4.6.5"`.
 *
 * The rule reads the Nx project graph, which LAGS the files on disk: a
 * dependency installed and imported a minute ago is not in it yet, whether
 * because the daemon has not rebuilt it or because `.nx/workspace-data` is
 * stale. So "not used by this project" is routinely false, and the fixer acts
 * on it anyway.
 *
 * Observed on a real workspace, not inferred. After installing and importing
 * `playwright`, a later `npm run format` removed `cheerio`, `jsonpath-plus`
 * and `playwright` from the manifest and re-pinned `zod`. The next
 * `npm install` synced the lockfile to the damaged manifest. Then rollup —
 * which externalises exactly what the manifest declares — INLINED Playwright:
 * the bundle went from 102 KB to 9 MB and opened with an unresolvable
 * `import ... from 'chromium-bidi/...'`. No step errored, and the published
 * package would have been broken.
 *
 * `checkMissingDependencies` stays on. Its fixer only ever calls
 * `insertTextAfter`, so the worst a stale graph can do there is add a
 * dependency that was already needed — recoverable by reading a diff, which
 * the other two are not.
 *
 * The cost is real and worth stating: an obsolete dependency now has to be
 * noticed by a human or by `mnci doctor`. That is the right trade. A lint rule
 * that silently deletes a runtime dependency from a package about to be
 * published is not a safety net, it is the hazard.
 *
 * Two exclusions are load-bearing:
 *
 * - `ignoredDependencies` — private workspace libs are compiled INTO a
 *   publishable package's rollup bundle and never declared in its manifest (a
 *   consumer could not install them). Computed at lint time by scanning for
 *   `private: true` manifests, so adding an internal lib never requires
 *   editing config.
 * - `ignoredFiles` — rollup bundles from the entry point only, so config files
 *   and specs never reach the published package; their imports must not drive
 *   the published manifest. Without the spec/vitest entries a fresh
 *   vitest-stack `npm-lib` fails `npm run lint` out of the box.
 *
 * @param workspaceRoot - Absolute path to the workspace root.
 * @returns The flat config blocks, or an empty array when Nx is absent.
 */
export default function dependencyChecks (workspaceRoot) {
  // No Nx present means no project graph to check against — skip rather than
  // crash, so this package stays usable outside an Nx workspace.
  if (!nxPlugin) {
    return []
  }

  const privateWorkspacePackages = globSync(['libs/*/package.json', 'packages/*/package.json'], {
    cwd: workspaceRoot,
  })
    .map(manifestPath => JSON.parse(readFileSync(join(workspaceRoot, manifestPath), 'utf8')))
    .filter(manifest => manifest.private === true)
    .map(manifest => manifest.name)

  return [
    {
      name:            'mnci/nx-dependency-checks',
      files:           ['packages/*/package.json', 'libs/*/package.json'],
      languageOptions: { parser: jsoncParser },
      plugins:         { '@nx': nxPlugin },
      rules:           {
        '@nx/dependency-checks': [
          'error',
          {
            // See the note above: both of these have destructive fixers and
            // read a project graph that lags the disk.
            checkObsoleteDependencies: false,
            checkVersionMismatches:    false,
            // Additive fixer only, so a stale graph cannot lose anything.
            checkMissingDependencies:  true,
            ignoredDependencies:       privateWorkspacePackages,
            ignoredFiles:              [
              '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
              '{projectRoot}/rollup.config.{js,ts,mjs,mts,cjs,cts}',
              '{projectRoot}/tsup.config.{js,ts,mjs,mts,cjs,cts}',
              '{projectRoot}/vite.config.{js,ts,mjs,mts,cjs,cts}',
              '{projectRoot}/vitest.config.{js,ts,mjs,mts,cjs,cts}',
              '{projectRoot}/jest.config.{js,ts,mjs,mts,cjs,cts}',
              '{projectRoot}/**/*.spec.{js,ts,jsx,tsx}',
              '{projectRoot}/**/*.test.{js,ts,jsx,tsx}',
            ],
          },
        ],
      },
    },
  ]
}
