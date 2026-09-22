/**
 * Rewrites the rollup configs of already-generated libraries so they emit usable
 * source maps and declaration specifiers.
 *
 * @remarks
 * The same repairs `mnci add` applies at generation time, applied after the
 * fact: `mnci upgrade` runs them across an existing workspace, and a freshly
 * generated project gets the declaration fix on the spot.
 */

import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileExists, writeFileEnsured } from '../file-system'
import {
  ROLLUP_CONFIG_PLACEHOLDER,
  ROLLUP_CONFIG_WITH_DTS_FIX,
  withRollupSourceMaps,
  withUpgradedDeclarationSpecifierPlugin,
} from './rollup-config.algorithm'

/**
 * Sweeps every publishable project's rollup config, enabling source maps.
 *
 * @remarks
 * Called by `mnci upgrade`, so a workspace generated before this shipped stops
 * being undebuggable without anyone editing a config by hand. Scoped to
 * `packages/*` and `libs/*` because those are the only places mnci puts a
 * rollup-built project.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The workspace-relative paths that changed.
 * @throws Propagates any `fs` write error.
 * @typeParam None - this function has no generic type parameters.
 */
export function repairRollupSourceMaps (workspaceRoot: string): string[] {
  const changed: string[] = []
  const configs = globSync(['packages/*/rollup.config.cjs', 'libs/*/rollup.config.cjs'], {
    cwd: workspaceRoot,
  })

  for (const relativePath of configs) {
    const configPath = join(workspaceRoot, relativePath)
    const before = readFileSync(configPath, 'utf8')
    const after = withRollupSourceMaps(before)
    if (after !== before) {
      writeFileEnsured(configPath, after)
      changed.push(relativePath.replaceAll('\\', '/'))
    }
  }

  return changed
}

/**
 * Sweeps every publishable project's rollup config, upgrading an existing
 * declaration-specifier plugin to the current version.
 *
 * @remarks
 * Called by `mnci upgrade`, the same way {@link repairRollupSourceMaps} is —
 * scoped to `packages/*` and `libs/*` for the same reason: those are the
 * only places mnci puts a rollup-built project.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The workspace-relative paths that changed.
 * @throws Propagates any `fs` write error.
 * @typeParam None - this function has no generic type parameters.
 */
export function upgradeDeclarationSpecifierPlugins (workspaceRoot: string): string[] {
  const changed: string[] = []
  const configs = globSync(['packages/*/rollup.config.cjs', 'libs/*/rollup.config.cjs'], {
    cwd: workspaceRoot,
  })

  for (const relativePath of configs) {
    const configPath = join(workspaceRoot, relativePath)
    const before = readFileSync(configPath, 'utf8')
    const after = withUpgradedDeclarationSpecifierPlugin(before)
    if (after !== before) {
      writeFileEnsured(configPath, after)
      changed.push(relativePath.replaceAll('\\', '/'))
    }
  }

  return changed
}

/**
 * Adds a rollup plugin that repairs the declaration stub the build emits.
 *
 * @remarks
 * `@nx/rollup` writes `dist/index.d.ts` as a stub re-exporting the real
 * declarations, building the specifier with `path.relative()` — an OS-native path.
 * On a Windows agent that yields `export * from "./src\\index"`, which is not a
 * valid module specifier on any platform: a specifier is URL-style, so `/` is right
 * everywhere and a backslash nowhere. It resolves on Windows only because the
 * resolver normalises separators there, so a package built there is untyped on Linux
 * and macOS. Confirmed in a real published tarball.
 *
 * mnci already points `types` past the stub ({@link repairPublishableManifest}), so
 * nothing depends on it — this makes the emitted artifact correct rather than merely
 * bypassed. The two repairs are deliberately independent: the manifest one keeps
 * consumers working even if this config is later hand-edited.
 *
 * The same plugin also appends `.js` to every bare relative specifier across
 * `dist/**\/*.d.ts` — not just the stub. `tsconfig.lib.json` declares under
 * `moduleResolution: "bundler"`, where an extensionless relative import is
 * valid, so the REAL declarations (what `types` points at) carry the same bare
 * specifiers as the source. A consumer resolving under the workspace default,
 * `nodenext`, requires an explicit extension on every relative specifier;
 * without it `tsc` reports `TS2834`, and with `skipLibCheck` masking that, the
 * entry point's re-export fails to resolve at all and the package appears to
 * export nothing. Confirmed against a real packed tarball: zero exports
 * visible under `nodenext` before this, correct resolution after.
 *
 * Guarded on the exact placeholder the generators write, so a change to their
 * template makes this a no-op rather than corrupting the config.
 *
 * @param projectRoot - Absolute path to the generated project's directory.
 * @returns Nothing.
 * @throws Propagates any `fs` error raised while rewriting the config.
 * @typeParam None - this function has no generic type parameters.
 */
export function repairDeclarationSpecifiers (projectRoot: string): void {
  const configPath = join(projectRoot, 'rollup.config.cjs')
  if (!fileExists(configPath)) {
    return
  }
  const config = readFileSync(configPath, 'utf8')
  if (!config.includes(ROLLUP_CONFIG_PLACEHOLDER)) {
    return
  }
  // Declaration stub FIRST, source maps second, and the order is load-bearing:
  // `withRollupSourceMaps` anchors on the `},` / `{` boundary between withNx's
  // two arguments and rewrites the `{` line, which is the same line the
  // placeholder starts with. Run the other way round it silently matches
  // nothing and the dts plugin is never written.
  const withDtsFix = config.split(ROLLUP_CONFIG_PLACEHOLDER).join(ROLLUP_CONFIG_WITH_DTS_FIX)
  writeFileEnsured(configPath, withRollupSourceMaps(withDtsFix))
}
