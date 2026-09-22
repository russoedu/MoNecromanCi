/**
 * Repoints a generated publishable library's manifest at the declaration file its
 * build actually emits, and keeps declaration maps out of the tarball.
 *
 * @remarks
 * Applies to both `npm-lib` and `react-lib`, at generation time and again from
 * `mnci upgrade` for libraries generated before the repair existed.
 */

import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, toJson, writeFileEnsured } from '../file-system'

/**
 * The declaration path the rollup-bundled library generators write, which their
 * own build never produces.
 */
const WRONG_TYPES_PATH = './dist/index.esm.d.ts'

/**
 * The real declaration file, pointed at directly rather than through the stub.
 *
 * @remarks
 * `@nx/rollup`'s `dts-bundle` plugin emits declarations at `dist/src/index.d.ts` and
 * then writes a stub `dist/index.d.ts` that re-exports from them. The obvious target
 * is that stub, and it is the wrong one: the plugin builds the specifier with
 * `path.relative()`, which returns an OS-NATIVE path, so on a Windows agent the stub
 * reads
 *
 * ```
 * export * from "./src\\\\index";
 * ```
 *
 * A module specifier is URL-style, not a filesystem path - `/` is correct on every
 * platform and `\\` is correct on none. It resolves on Windows only because the
 * resolver normalises separators there; on Linux and macOS a backslash is an ordinary
 * filename character, so the package is untyped for those consumers. Confirmed in a
 * real published tarball built on a Windows CI pool.
 *
 * Both library kinds share the layout, so this path is right for both:
 * `@nx/rollup`'s configuration generator writes `main: './src/index.ts'` for every
 * project it configures, and `@nx/js:lib` and `@nx/react:library` both route through
 * it.
 *
 * The stub still ships and is simply unused. Upstream fix tracked in ROADMAP 7c.
 */
const ACTUAL_TYPES_PATH = './dist/src/index.d.ts'

/**
 * Keeps declaration source maps out of the published tarball.
 *
 * @remarks
 * `declarationMap` is on workspace-wide (`create-nx-workspace` writes it into
 * `tsconfig.base.json`) and is genuinely useful INSIDE the monorepo, where
 * go-to-definition across projects lands on the original `.ts`. It is dead weight
 * in a published package, because `files: ["dist"]` ships no sources for the maps
 * to point at: measured on a real published library, every `.d.ts.map` carried
 * `sources: ["../src/<name>.ts"]`, a path outside the tarball. They were also HALF
 * the package - 32 of its 67 files - so an editor following one lands on nothing
 * while every consumer downloads them.
 *
 * Excluded from `files` rather than by switching `declarationMap` off, so in-repo
 * navigation keeps working.
 */
const DECLARATION_MAP_EXCLUSION = '!**/*.d.ts.map'

/**
 * Keeps JavaScript source maps out of the published tarball.
 *
 * @remarks
 * The counterweight to building them unconditionally. A `.js.map` carries the
 * whole of `sourcesContent` - every line of the package's TypeScript - so
 * publishing them would multiply the tarball for a benefit only this
 * workspace's own debugger collects. Same reasoning as
 * {@link DECLARATION_MAP_EXCLUSION}.
 */
const SOURCE_MAP_EXCLUSION = '!**/*.js.map'

/**
 * Repairs the manifest of a generated publishable library: repoints its `types`
 * entries at the declaration file the build actually emits, and keeps declaration
 * maps out of the tarball.
 *
 * @remarks
 * Works around a real inconsistency in the `--bundler=rollup` library generators,
 * not a preference: they write `types: './dist/index.esm.d.ts'` (and the same path
 * under `exports['.']`), while the rollup build emits `dist/index.d.ts`. The
 * referenced file therefore never exists, so **every TypeScript consumer of the
 * published package gets `any`**, failing with
 * `TS7016: Could not find a declaration file for module '@scope/name'`.
 *
 * Applies to BOTH `@nx/js:lib` (`npm-lib`) and `@nx/react:library` (`react-lib`).
 * It lived in `reactLib.ts` alone for a while, which is how `npm-lib` shipped the
 * defect: the bug was found, diagnosed and fixed on one code path while the other
 * called the same generator family with the same flag. Measured on a real published
 * workspace — a consumer importing `@auto/env` failed `TS7016`, and repointing
 * `types` alone made it resolve, with a deliberate type error then reported
 * correctly.
 *
 * `main`/`module` are left alone: they correctly point at `index.esm.js`, which IS
 * emitted. Only the declaration paths are wrong.
 *
 * Guarded on the exact wrong value, so if Nx corrects this upstream the repair
 * quietly stops applying instead of overwriting a now-correct path.
 *
 * @param manifestPath - Absolute path to the library's `package.json`.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
export function repairPublishableManifest (manifestPath: string): void {
  const manifest = readJson<{
    types?:   string
    files?:   string[]
    exports?: Record<string, string | { types?: string }>
  }>(manifestPath)

  if (manifest.types === WRONG_TYPES_PATH) {
    manifest.types = ACTUAL_TYPES_PATH
  }
  const dot = manifest.exports?.['.']
  if (typeof dot === 'object' && dot.types === WRONG_TYPES_PATH) {
    dot.types = ACTUAL_TYPES_PATH
  }
  for (const exclusion of [DECLARATION_MAP_EXCLUSION, SOURCE_MAP_EXCLUSION]) {
    if (manifest.files && !manifest.files.includes(exclusion)) {
      manifest.files.push(exclusion)
    }
  }
  writeFileEnsured(manifestPath, toJson(manifest))
}

/**
 * Sweeps every project's manifest through {@link repairPublishableManifest}.
 *
 * @remarks
 * Called by `mnci upgrade`. `repairPublishableManifest` itself only runs at
 * `add` time (from `addNpmLib`/`addReactLib`/`addReactInternalLib`), so a
 * project `add`ed before this repair existed — or one whose manifest was
 * later hand-edited back to the wrong `types` path — never gets revisited.
 * `repairPublishableManifest` is already unconditional and idempotent (it
 * only changes a field that is actually wrong, and only adds a `files`
 * exclusion that is actually missing), so it is safe to call on every
 * project's manifest regardless of kind: a manifest with none of the wrong
 * values is read and re-serialised unchanged.
 *
 * Scoped to `packages/*` and `libs/*` for the same reason
 * {@link repairRollupSourceMaps} is: those are the only places a JS/TS
 * project's `package.json` lives.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The workspace-relative paths that changed.
 * @throws Propagates any `fs`/JSON error.
 * @typeParam None - this function has no generic type parameters.
 */
export function repairPublishableManifests (workspaceRoot: string): string[] {
  const changed: string[] = []
  const manifests = globSync(['packages/*/package.json', 'libs/*/package.json'], {
    cwd: workspaceRoot,
  })

  for (const relativePath of manifests) {
    const manifestPath = join(workspaceRoot, relativePath)
    const before = readFileSync(manifestPath, 'utf8')
    repairPublishableManifest(manifestPath)
    const after = readFileSync(manifestPath, 'utf8')
    if (after !== before) {
      changed.push(relativePath.replaceAll('\\', '/'))
    }
  }

  return changed
}
