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
export default function dependencyChecks(workspaceRoot) {
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
      files: ['packages/*/package.json', 'libs/*/package.json'],
      languageOptions: { parser: jsoncParser },
      plugins: { '@nx': nxPlugin },
      rules: {
        '@nx/dependency-checks': [
          'error',
          {
            ignoredDependencies: privateWorkspacePackages,
            ignoredFiles: [
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
