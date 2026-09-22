import { existsSync, globSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runNx, runShell } from '../nx-workspace'
import { dependabotConfig, reactExpressPeerOverride } from '../workspace-overlay'
import { fileExists, readCodeWorkspace, readJson, toJson, writeFileEnsured } from '../file-system'
import { logger } from '../terminal'

/**
 * The HTTP frameworks `@nx/node:application` can scaffold a `node-app` with.
 *
 * @remarks
 * The generator's own `--framework` choices (verified empirically against a
 * real Nx 23.1.0 workspace: `nx g @nx/node:application --help`), passed
 * straight through — `node.ts` adds no framework-specific logic of its own.
 * `none` (the default) is a bare Node app with no HTTP framework opinion.
 * `node-function-app` never accepts this: the Azure Functions v4 programming
 * model (`app.http(...)` registration) runs its own request lifecycle, so a
 * full HTTP server framework doesn't apply there.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type NodeFramework = 'express' | 'fastify' | 'koa' | 'nest' | 'none'

/**
 * Options accepted by `runAdd`.
 *
 * @remarks
 * Mirrors the CLI's flags. Defined here (not in `add.ts`) because every
 * per-kind module (`react-app.ts`, `function-app.ts`, `npm-lib.ts`) needs it;
 * `add.ts` re-exports it so its existing public import path
 * (`import { type AddOptions } from './commands/add'`, used by `cli.ts`)
 * keeps working unchanged.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface AddOptions {
  /** npm scope for a publishable lib's import path (defaults to `@<workspace name>`). */
  scope?:     string
  /** `node-app` only: the HTTP framework `@nx/node:application` scaffolds (defaults to `none`, a bare Node app). */
  framework?: NodeFramework
  /** `python-vendor` only: the internal Python library (under `libs/`) to vendor into `name`. */
  lib?:       string
}

/**
 * The workspace stack, generator-facing shape (what `readWorkspaceStack` in
 * `add.ts` resolves and every plugin-generated kind consumes).
 *
 * @remarks
 * Only testRunner is configurable; linting and formatting are always ESLint.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface WorkspaceStack {
  testRunner: 'jest' | 'vitest'
}

/**
 * Whether a plugin package is already declared in the workspace's manifest.
 *
 * @remarks
 * Keeps repeat `add` calls fast by skipping the install step.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param packageName - The plugin package (e.g. `@nx/react`).
 * @returns `true` when the package is a dependency or devDependency.
 * @throws Propagates any `fs`/JSON error reading the root manifest.
 * @typeParam None - this function has no generic type parameters.
 */
export function hasPlugin (workspaceRoot: string, packageName: string): boolean {
  const manifest = readJson<{
    dependencies?:    Record<string, string>
    devDependencies?: Record<string, string>
  }>(join(workspaceRoot, 'package.json'))
  const installed = { ...manifest.dependencies, ...manifest.devDependencies }

  return Object.hasOwn(installed, packageName)
}

/**
 * Ensures an Nx plugin is installed in the workspace, installing it on first use.
 *
 * @remarks
 * `nx add` installs the package and runs its init generator — the Nx-native way
 * to bring a plugin into an existing workspace. Shared by every kind whose
 * generator lives in a plugin the workspace may not have yet (`react-app`,
 * `react-lib`, `react-internal-lib`).
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param packageName - The plugin package (e.g. `@nx/react`).
 * @returns Nothing.
 * @throws Error when the underlying `nx add` exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
export function ensurePlugin (workspaceRoot: string, packageName: string): void {
  if (hasPlugin(workspaceRoot, packageName)) {
    return
  }
  logger.step(`Installing Nx plugin ${packageName}`)
  runNx(['add', packageName], workspaceRoot)
}

/**
 * Runs an Nx generator, then applies mnci's own post-generation repairs even
 * when the generator's underlying install step failed.
 *
 * @remarks
 * `@nx/js:lib --bundler=rollup`/`@nx/react:library` both fetch and install a
 * plugin package (`@nx/rollup`, `@nx/vitest`, …) as part of the generator run
 * the FIRST time a workspace uses that bundler or test runner, via Nx's own
 * `installPackagesTask`. That install can fail for reasons that have nothing
 * to do with the generator's own correctness — reproduced end to end with a
 * real npm 10.9.7 arborist bug on this exact dependency tree
 * (`Cannot read properties of null (reading 'edgesOut')`, gone on npm 11) —
 * and when it does, `runNx` throws AFTER the generator has already written
 * every scaffold file to disk. Without this wrapper, every caller's own
 * post-generation repairs (`repairPublishableManifest`,
 * `repairDeclarationSpecifiers`, `registerProjectCommands`, …) never run,
 * silently, because the exception unwinds straight out of `addNpmLib`/
 * `addReactLib` — leaving a project with the broken `types` path and the
 * unrepaired source-map/declaration-extension defects those repairs exist to
 * fix, and `mnci doctor` had nothing that could point at it: the target
 * files exist, they are just wrong. Reproduced and fixed together.
 *
 * The distinguishing signal is `markerPath`: a file the generator itself
 * writes (its manifest) as one of its very first acts, well before the
 * install step runs. If it is missing, the generator failed before writing
 * anything repairable, and this rethrows the original error unchanged rather
 * than running repairs against a directory that does not exist. If it is
 * present, the scaffold is real regardless of whether install succeeded, so
 * `repair` runs unconditionally — and if install did fail, the original
 * error is rethrown afterwards, with a clearer, actionable message, so the
 * command still exits non-zero rather than reporting a false success.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param nxArguments - The Nx CLI arguments, exactly as `runNx` would take them.
 * @param markerPath - Absolute path to a file the generator writes early,
 * used to tell "failed before writing anything" apart from "failed after".
 * @param repair - Every post-generation repair this kind normally runs on
 * success; now run whenever the scaffold exists, success or not.
 * @returns Nothing.
 * @throws The original `runNx` error, unchanged, when `markerPath` was never
 * written. A new, clearer error wrapping it, after `repair` has still run,
 * when `markerPath` exists but the generator's install step failed anyway.
 * @typeParam None - this function has no generic type parameters.
 */
export function runGeneratorAndRepair (
  workspaceRoot: string,
  nxArguments: string[],
  markerPath: string,
  repair: () => void,
): void {
  let installFailure: Error | undefined
  try {
    runNx(nxArguments, workspaceRoot)
  } catch (error) {
    installFailure = error instanceof Error ? error : new Error(String(error))
  }

  if (!fileExists(markerPath)) {
    throw installFailure ?? new Error(`unreachable: runNx did not throw and ${markerPath} is missing`)
  }

  repair()

  if (installFailure) {
    throw new Error(
      'The project was generated and mnci\'s own repairs were applied, but the ' +
        `underlying Nx generator's install step still failed (${installFailure.message}). ` +
        "Fix the install error above (commonly resolved by 'npm install' with a newer " +
        "npm major), then verify with 'mnci doctor'.",
    )
  }
}

/**
 * Sets `"private": true` in a package manifest.
 *
 * @remarks
 * One of the deliberate post-generation touches: it makes an internal library
 * structurally unpublishable, no matter what future config drifts. Shared by
 * every private-lib kind (`internal-lib`, `react-internal-lib`).
 *
 * @param manifestPath - Absolute path to the lib's `package.json`.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
export function markPrivate (manifestPath: string): void {
  const manifest = readJson<Record<string, unknown>>(manifestPath)
  writeFileEnsured(manifestPath, toJson({ ...manifest, private: true }))
}

/**
 * Sets `publishConfig.access: "public"` in a package manifest.
 *
 * @remarks
 * npm treats every scoped package (`@scope/name` — what every publishable lib's
 * `importPath` always is) as private by default: an unmodified first publish
 * fails with `402 Payment Required — You must sign up for private packages`
 * (verified empirically against the real registry), not with anything a dry-run
 * surfaces, since dry-runs never call the registry. This is the one
 * post-generation touch that makes a freshly added publishable lib publishable
 * as-is. Shared by `npm-lib` and `react-lib`.
 *
 * @param manifestPath - Absolute path to the lib's `package.json`.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
export function markPublic (manifestPath: string): void {
  const manifest = readJson<Record<string, unknown>>(manifestPath)
  writeFileEnsured(manifestPath, toJson({ ...manifest, publishConfig: { access: 'public' } }))
}

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

const ROLLUP_CONFIG_PLACEHOLDER = [
  '  {',
  '    // Provide additional rollup configuration here. See: https://rollupjs.org/configuration-options',
  '    // e.g.',
  '    // output: { sourcemap: true },',
  '  }',
].join('\n')

/**
 * The compiler `@nx/js:lib --bundler=rollup` hardcodes, and what mnci swaps it for.
 *
 * @remarks
 * **Without this swap the source maps are emitted but empty, so none of the
 * rest of this works.** `@nx/rollup`'s own configuration generator defaults
 * `compiler` to `babel`; `@nx/js:lib` passes `compiler: 'swc'` explicitly and
 * unconditionally, so every publishable library mnci generates is built with
 * swc. And `@nx/rollup`'s swc plugin calls swc's `transform()` **without**
 * `sourceMaps: true`, so it returns no map at all. A rollup transform hook that
 * returns no map breaks the chain: the output map comes out structurally valid
 * and semantically empty - `sources: []`, every mapping segment blank - which
 * is indistinguishable from a working build until a breakpoint refuses to bind.
 *
 * Measured on a real package in this repo: swc gave `sources: []`; the same
 * package on babel gave 9 sources, all resolving, with `sourcesContent`.
 *
 * Swapping the compiler is the fix rather than shipping a plugin that re-runs
 * swc with maps on, because two transform hooks would both compile the same
 * source and the second would see the first's output. Revert this the moment
 * `@nx/rollup` passes `sourceMaps` through - the upstream fix is one option in
 * `plugins/swc.js`.
 *
 * A regex, not a plain string, for the same reason {@link hasRollupSourceMaps}
 * is one: `@stylistic/key-spacing` (aligned on value) pads every property in
 * this object out to the longest key's column the moment `eslint --fix` runs
 * over it - which every mnci-generated file gets, and `outputPath`/`tsConfig`
 * both outrun `compiler`, so the padding fires on effectively every real
 * config. A literal `"    compiler: 'swc',"` only matches the pristine,
 * never-formatted generator output; on a workspace where the repair is
 * reached late (a failed `add` finished by a later `mnci upgrade`, or an
 * older mnci version's already-formatted output) the line reads
 * `compiler:   'swc',` and the literal silently fails to match, leaving swc's
 * empty source maps in place while `mnci upgrade` reports success. Confirmed
 * end to end: a real crashed `add npm-lib` left `rollup.config.cjs`
 * unrepaired, one `npm run format` key-spacing-aligned it, and the literal
 * swap then no-op'd on the following `mnci upgrade`.
 */
const GENERATED_COMPILER_PATTERN = /^( {4})compiler\s*:\s*'swc',$/m

/**
 * Builds the source-map-capable compiler line (plus its explaining comment)
 * at the given indent, matched from {@link GENERATED_COMPILER_PATTERN}'s
 * capture so the replacement lines up whatever the original indentation was.
 */
function sourceMapCapableCompiler (indent: string): string {
  return [
    `${indent}// Swapped from swc by MoNecromanCI. @nx/rollup runs swc without`,
    `${indent}// sourceMaps, so it returns no map and the bundle's map comes out empty -`,
    `${indent}// valid-looking, and useless for debugging. See ROADMAP.`,
    `${indent}compiler: 'babel',`,
  ].join('\n')
}

/**
 * The end of `withNx`'s FIRST argument, with source maps switched on.
 *
 * @remarks
 * `sourceMap` has to be set here and nowhere else. The obvious spot is
 * `output: { sourcemap: true }` in the second argument - the generator's own
 * placeholder comment even suggests it - and it silently does nothing:
 * `withNx` spreads the caller's `output` and *then* assigns
 * `sourcemap: options.sourceMap`, so its own (undefined) value always wins.
 *
 * Unconditional rather than gated behind a dev flag. Maps are what make a
 * breakpoint in a `.ts` file bind, so a build without them is undebuggable, and
 * every way of gating it costs something a generated workspace should not pay:
 * an env var is not portable across npm scripts without a fourth runtime
 * dependency, and a second build target is one more thing to remember at
 * exactly the moment you are already debugging. The maps are always built and
 * never *published* instead - {@link repairPublishableManifest} keeps them out
 * of `files`, the same trade this project already made for `.d.ts.map`.
 */
const ROLLUP_ARG_ONE_BOUNDARY = ['  },', '  {', ''].join('\n')

/** The same boundary, with the source-map flag appended to argument one. */
const ROLLUP_ARG_ONE_WITH_SOURCE_MAPS = [
  '    // Added by MoNecromanCI: without this rollup emits no .js.map at all, so',
  '    // a breakpoint in a .ts file can never bind. Not published - see `files`.',
  '    sourceMap: true',
  '  },',
  '  {',
  '',
].join('\n')

/**
 * Whether a rollup config already carries the source-map wiring.
 *
 * @remarks
 * The idempotence guard for both entry points, and what `mnci doctor` asks so
 * its finding and `mnci upgrade`'s edit can never disagree about what "already
 * fixed" means.
 *
 * A literal `config.includes('sourceMap: true')` broke on both halves of that
 * contract at once: `@mnci/eslint-config`'s `@stylistic/key-spacing` (aligned
 * on value) is entitled to rewrite `sourceMap: true,` to
 * `sourceMap:             true,` to line up with whatever the object's
 * longest key is, and `eslint --fix` runs on every mnci-generated file. Tested
 * with a regex rather than a plain substring so any amount of horizontal
 * whitespace around the colon - however a formatter chooses to lay it out -
 * still reads as "already on".
 *
 * @param config - The config file's text.
 * @returns `true` when source maps are already switched on.
 * @throws Never - performs a regex test.
 * @typeParam None - this function has no generic type parameters.
 */
export function hasRollupSourceMaps (config: string): boolean {
  return /sourceMap\s*:\s*true\b/.test(config)
}

/**
 * Whether `withRollupSourceMaps` can repair this config.
 *
 * @remarks
 * The write-time twin of {@link hasRollupSourceMaps}'s idempotence test:
 * `withRollupSourceMaps` anchors its edit on the `},` / `{` boundary between
 * `withNx`'s two arguments, so a config that never has that boundary in its
 * OWN text cannot be repaired no matter how many times `mnci upgrade` runs -
 * most commonly a one-line delegation to a shared base file, e.g.
 * `module.exports = require('../../rollup.base.cjs')()`, which mnci does not
 * own and has nothing to anchor on. `mnci doctor` uses this to decide whether
 * recommending `mnci upgrade` would actually fix anything, rather than
 * pointing the user at a command that silently no-ops.
 *
 * @param config - The config file's own text (not resolved through `require()`).
 * @returns `true` when `withRollupSourceMaps` has a boundary to anchor on.
 * @throws Never - performs a substring test.
 * @typeParam None - this function has no generic type parameters.
 */
export function canRepairRollupConfig (config: string): boolean {
  return config.includes(ROLLUP_ARG_ONE_BOUNDARY)
}

/**
 * Switches source maps on in a rollup config, whatever shape it is in.
 *
 * @remarks
 * Deliberately not anchored on the generator's placeholder comment. That
 * comment survives only until mnci replaces it at `add` time, so a placeholder
 * anchor would work for a brand-new project and silently no-op for every
 * existing one - which is the whole population `mnci upgrade` exists to reach.
 * The `},` / `{` boundary between `withNx`'s two arguments is present in both
 * shapes, so it anchors both.
 *
 * Idempotent: a config that already has the flag is returned untouched, so
 * running `mnci upgrade` twice changes nothing the second time. That guard is
 * {@link hasRollupSourceMaps} rather than a second literal, deliberately -
 * two independent "is it already on" checks are two things that can disagree,
 * and disagreeing here means inserting a second `sourceMap: true` into a
 * config `eslint --fix` had only reformatted, not left off.
 *
 * @param config - The config file's text.
 * @returns The config with source maps enabled, or unchanged when already so.
 * @throws Never - an unrecognised config is returned unchanged.
 * @typeParam None - this function has no generic type parameters.
 */
export function withRollupSourceMaps (config: string): string {
  if (hasRollupSourceMaps(config) || !canRepairRollupConfig(config)) {
    return config
  }
  const withCompiler = config.replace(GENERATED_COMPILER_PATTERN, (_match, indent: string) =>
    sourceMapCapableCompiler(indent),
  )
  const withFlag = withCompiler.replace(
    ROLLUP_ARG_ONE_BOUNDARY,
    () => ROLLUP_ARG_ONE_WITH_SOURCE_MAPS,
  )

  return withFlag.includes('sourcemapPathTransform')
    ? withFlag
    : withFlag.replace(
        ROLLUP_ARG_ONE_WITH_SOURCE_MAPS,
        () => `${ROLLUP_ARG_ONE_WITH_SOURCE_MAPS}${SOURCEMAP_PATH_TRANSFORM}`,
      )
}

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
 * Resolves a relative `require()` specifier to a real file.
 *
 * @remarks
 * Tries the specifier as given first, then the extensions a `.cjs` rollup
 * config (or a shared base it delegates to) is realistically written with -
 * `require()` itself resolves the same way, this just needs to agree with it
 * without actually loading the module.
 *
 * @param fromDir - The directory the `require()` call is made from.
 * @param specifier - The relative specifier passed to `require()`.
 * @returns The resolved absolute path, or `undefined` when none of the
 *   candidates exist.
 * @throws Never - only checks the filesystem.
 * @typeParam None - this function has no generic type parameters.
 */
function resolveRequireTarget (fromDir: string, specifier: string): string | undefined {
  const base = join(fromDir, specifier)

  return [base, `${base}.cjs`, `${base}.js`].find(candidate => fileExists(candidate))
}

/**
 * Reads a rollup config's text, following local `require()` delegation so a
 * config hoisted into a shared base file is read as if it were inlined.
 *
 * @remarks
 * A workspace that pulls the `withNx(...)` call out into one root
 * `rollup.base.cjs` and leaves each project as
 * `module.exports = require('../../rollup.base.cjs')()` has no
 * `sourceMap: true` text of its own to find - {@link hasRollupSourceMaps}
 * reading only the project's own file would report every such project as
 * missing source maps even when every one genuinely has them, because the
 * flag lives one file away. Text-based rather than an actual `require()` of
 * the config, deliberately: `mnci doctor` is read-only, and evaluating a
 * user's build config as code to answer a yes/no question is a far larger
 * blast radius than reading more of its text.
 *
 * Only RELATIVE requires (`./…`, `../…`) are followed - an npm package's
 * installed source (e.g. `@nx/rollup/with-nx`) is never something this needs
 * to read, and grepping into node_modules would be both slow and pointless.
 * Each file is read at most once, so a require cycle terminates rather than
 * recursing forever.
 *
 * @param configPath - Absolute path to the rollup config being inspected.
 * @param visited - File paths already read, to stop a require cycle. Callers
 *   should omit this; it is populated by recursive calls.
 * @returns The config's own text, followed by the text of every local file it
 *   `require()`s, transitively.
 * @throws Never - an unreadable file or unresolvable require target is skipped.
 * @typeParam None - this function has no generic type parameters.
 */
export function resolveRollupConfigText (
  configPath: string,
  visited: Set<string> = new Set(),
): string {
  if (visited.has(configPath)) {
    return ''
  }
  visited.add(configPath)

  let text: string
  try {
    text = readFileSync(configPath, 'utf8')
  } catch {
    return ''
  }

  const specifiers = Array.from(
    text.matchAll(/require\((['"])(\.[^'"]*)\1\)/g),
    match => match[2],
  )
  const requiredText = specifiers
    .map(specifier => resolveRequireTarget(dirname(configPath), specifier))
    .filter((target): target is string => target !== undefined)
    .map(target => resolveRollupConfigText(target, visited))

  return [text, ...requiredText].join('\n')
}

/** The `output` block that repairs rollup's wrong sourcemap source paths. */
const SOURCEMAP_PATH_TRANSFORM = [
  '    // Added by MoNecromanCI. rollup hands sourcemapPathTransform an OS-NATIVE',
  '    // path with one parent segment too many, so `sources` resolve to nothing',
  '    // and no breakpoint can bind. Separators are normalised too: a sources',
  '    // entry is URL-style, so a backslash is wrong on every platform.',
  '    output: {',
  '      sourcemapPathTransform: relativeSourcePath =>',
  '        relativeSourcePath',
  "          .replaceAll(String.fromCodePoint(92), '/')",
  "          .replace(/^([.][.][/])+/, '../')",
  '    },',
  '',
].join('\n')

/**
 * A unique substring of {@link DECLARATION_SPECIFIER_PLUGIN}'s `name`,
 * present whenever the plugin exists in a rollup config at all — including a
 * version written before the `.js`-extension capability below existed.
 */
const DECLARATION_SPECIFIER_PLUGIN_MARKER = "name: 'mnci-normalise-declaration-specifiers'"

/**
 * A unique identifier {@link DECLARATION_SPECIFIER_PLUGIN} only contains once
 * it also appends `.js` to bare relative specifiers — absent from the
 * earlier version that only normalised the stub's backslashes.
 */
const DECLARATION_SPECIFIER_EXTENSION_MARKER = 'bareRelativeSpecifier'

/**
 * A unique identifier {@link DECLARATION_SPECIFIER_PLUGIN} only contains once
 * it resolves a bare specifier's suffix against what rollup actually emitted
 * — absent from the earlier version that appended `.js` unconditionally.
 *
 * @remarks
 * That earlier version could not tell a file specifier from a directory
 * barrel: `./scan-session` needs `/index.js`, not `.js` (a file that was
 * never emitted), and ESM resolution has no directory-index fallback — so an
 * affected import silently degraded the whole module to `any` under
 * `skipLibCheck`, the default in most consumers. Confirmed against a real
 * published tarball.
 */
const DECLARATION_SPECIFIER_DIRECTORY_MARKER = 'resolveSpecifierSuffix'

/**
 * Whether a rollup config carries the declaration-specifier plugin at all.
 *
 * @remarks
 * Exported as a predicate rather than exporting the marker string itself, so
 * `mnci doctor` asks this module the question instead of re-implementing the
 * detection and drifting from it — the same contract
 * {@link hasRollupSourceMaps} already has with that caller.
 *
 * @param config - The config file's text, resolved through any shared base.
 * @returns `true` when the plugin is present, current or not.
 * @throws Never - performs a substring test.
 * @typeParam None - this function has no generic type parameters.
 */
export function hasDeclarationSpecifierPlugin (config: string): boolean {
  return config.includes(DECLARATION_SPECIFIER_PLUGIN_MARKER)
}

/**
 * Whether that plugin resolves a bare specifier against what was emitted,
 * rather than appending `.js` unconditionally.
 *
 * @remarks
 * The distinction is the whole point of checking: a config carrying the
 * EARLIER plugin looks healthy by every other measure — the plugin is there,
 * the build succeeds, the package publishes — and still ships `any` for every
 * export behind a directory barrel, because `./scan-session` was rewritten to
 * `./scan-session.js`, a file rollup never emitted. Nothing reports it:
 * `skipLibCheck` (the default in most consumers) swallows the unresolved
 * import, and runtime is unaffected because the bundle never goes through
 * those specifiers. Measured in a real consuming workspace, 9 of 11 published
 * packages carried exactly that generation.
 *
 * Separate from {@link hasDeclarationSpecifierPlugin} so a missing plugin and
 * a stale one can be reported as the different findings they are, even though
 * `mnci upgrade` is the remedy for both.
 *
 * @param config - The config file's text, resolved through any shared base.
 * @returns `true` when the plugin is the current, directory-aware version.
 * @throws Never - performs a substring test.
 * @typeParam None - this function has no generic type parameters.
 */
export function hasDirectoryAwareDeclarationSpecifiers (config: string): boolean {
  return config.includes(DECLARATION_SPECIFIER_DIRECTORY_MARKER)
}

/**
 * The declaration-specifier plugin object, exactly as written into
 * `plugins: [ … ]`.
 *
 * @remarks
 * Its own text is the source of truth for both call sites that need it:
 * {@link ROLLUP_CONFIG_WITH_DTS_FIX} (a fresh `add`) and
 * {@link withUpgradedDeclarationSpecifierPlugin} (upgrading an existing one
 * in place), so the two can never drift into writing different plugin
 * bodies for the same generator version.
 */
const DECLARATION_SPECIFIER_PLUGIN = [
  '      {',
  "        name: 'mnci-normalise-declaration-specifiers',",
  '        writeBundle (outputOptions) {',
  "          const { existsSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')",
  "          const { join } = require('node:path')",
  "          const dir = outputOptions.dir ?? './dist'",
  "          const stub = join(dir, 'index.d.ts')",
  '          let source',
  '          try {',
  "            source = readFileSync(stub, 'utf8')",
  '          } catch {',
  '            return',
  '          }',
  '          // The stub carries a TWO-character escape (JSON.stringify escaped one',
  '          // backslash), so this must not match a single one - that would turn',
  String.raw`          // "./src\index" into "./src//index". Built from char codes so there is`,
  '          // no escaping in this file to get wrong.',
  '          const separator = String.fromCodePoint(92, 92)',
  "          const normalised = source.replaceAll(separator, '/')",
  '          if (normalised !== source) writeFileSync(stub, normalised)',
  '',
  String.raw`          const ${DECLARATION_SPECIFIER_EXTENSION_MARKER} = /from(\s+)(['"])(\.[^'"]+?)\2/g`,
  String.raw`          const hasExtension = /\.(?:mjs|cjs|jsx?|json)$/`,
  '          let entries',
  '          try {',
  '            entries = readdirSync(dir, { recursive: true, withFileTypes: true })',
  '          } catch {',
  '            return',
  '          }',
  '          for (const entry of entries) {',
  "            if (!entry.name.endsWith('.d.ts')) continue",
  '            const from = entry.parentPath ?? entry.path',
  '            const filePath = join(from, entry.name)',
  '            let declaration',
  '            try {',
  "              declaration = readFileSync(filePath, 'utf8')",
  '            } catch {',
  '              continue',
  '            }',
  '            // A bare specifier may name a FILE or a DIRECTORY BARREL - resolved',
  '            // against what rollup actually emitted next to this file, never',
  '            // guessed. A directory needs /index.js, not .js (a file that was',
  '            // never written); anything neither form matches is left alone rather',
  '            // than rewritten to a specifier that cannot resolve.',
  `            const ${DECLARATION_SPECIFIER_DIRECTORY_MARKER} = (specifier) => {`,
  '              if (hasExtension.test(specifier)) return null',
  "              if (existsSync(join(from, specifier + '.d.ts'))) return specifier + '.js'",
  "              if (existsSync(join(from, specifier, 'index.d.ts'))) return specifier + '/index.js'",
  '              return null',
  '            }',
  '            const withExtensions = declaration.replace(',
  `              ${DECLARATION_SPECIFIER_EXTENSION_MARKER},`,
  '              (match, space, quote, specifier) => {',
  `                const resolved = ${DECLARATION_SPECIFIER_DIRECTORY_MARKER}(specifier)`,
  '                return resolved === null ? match : `from${space}${quote}${resolved}${quote}`',
  '              },',
  '            )',
  '            if (withExtensions !== declaration) writeFileSync(filePath, withExtensions)',
  '          }',
  '        }',
  '      }',
].join('\n')

/** The same slot, carrying a plugin that repairs the declaration stub. */
const ROLLUP_CONFIG_WITH_DTS_FIX = [
  '  {',
  "    // Added by MoNecromanCI. @nx/rollup's dts-bundle plugin writes dist/index.d.ts",
  '    // as a stub re-exporting the real declarations, and builds that specifier with',
  '    // path.relative() - an OS-NATIVE path. On Windows it emits',
  String.raw`    //   export * from "./src\\index";`,
  '    // which is not a valid module specifier on ANY platform: a specifier is',
  '    // URL-style, so / is correct everywhere and a backslash nowhere. It resolves on',
  '    // Windows only because the resolver normalises separators there, leaving the',
  '    // package untyped on Linux and macOS.',
  '    //',
  '    // mnci also points `types` past this stub, so nothing depends on it being',
  '    // correct; this makes the emitted file correct too. Remove once Nx fixes the',
  '    // plugin - its own devkit already exports normalizePath for exactly this.',
  '    //',
  '    // The second half fixes a separate defect in the REAL declarations `types`',
  '    // points at: tsconfig.lib.json declares under moduleResolution "bundler",',
  '    // where a bare relative specifier ("./lib/align") is valid, so every emitted',
  '    // .d.ts keeps the source\'s own extensionless imports verbatim. A consumer on',
  '    // "moduleResolution": "nodenext" - the workspace root default - requires an',
  '    // explicit extension on every relative specifier and gets TS2834 (or,',
  '    // combined with skipLibCheck, a silent zero-export module) instead. Declared',
  '    // extensions are left untouched; only a bare relative specifier gets .js',
  '    // appended, matching what tsc itself emits under node16/nodenext.',
  '    plugins: [',
  DECLARATION_SPECIFIER_PLUGIN,
  '    ]',
  '  }',
].join('\n')

/**
 * Finds the `{ … }` span enclosing the first occurrence of `needle`, by
 * brace-counting rather than parsing.
 *
 * @remarks
 * Safe here specifically because {@link DECLARATION_SPECIFIER_PLUGIN} is
 * mnci's own generated content and contains no string or regex literal with
 * an unmatched `{`/`}` — checked by hand, and any future addition to that
 * plugin body must preserve it. `needle` is found first, then the span's
 * start is the nearest `{` before it (by construction, nothing but that
 * brace and whitespace can sit between them in a `{ name: … }` object
 * literal), and the end is wherever forward brace-counting from there first
 * returns to depth zero.
 *
 * @param text - The text to search.
 * @param needle - A substring known to appear inside the object to find.
 * @returns The `[start, end)` character span, `end` exclusive of nothing
 * (it points just past the closing `}`), or `undefined` when `needle` is
 * absent, has no preceding `{`, or the braces never balance.
 * @throws Never.
 * @typeParam None - this function has no generic type parameters.
 */
function findEnclosingBraceSpan (text: string, needle: string): [number, number] | undefined {
  const needleIndex = text.indexOf(needle)
  if (needleIndex === -1) {
    return undefined
  }
  const start = text.lastIndexOf('{', needleIndex)
  if (start === -1) {
    return undefined
  }
  let depth = 0
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '{') {
      depth += 1
    } else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) {
        return [start, index + 1]
      }
    }
  }

  return undefined
}

/**
 * Upgrades an already-written declaration-specifier plugin in place, so a
 * project `add`ed before the `.js`-extension capability existed picks it up.
 *
 * @remarks
 * {@link repairDeclarationSpecifiers} writes this plugin exactly once,
 * anchored on the generator's own placeholder — so a project `add`ed before
 * a later capability shipped keeps running the OLD plugin body forever, and
 * `mnci upgrade` never revisited it (unlike the source-map flag, which
 * {@link withRollupSourceMaps} does sweep). This closes that gap.
 *
 * Deliberately NOT a literal full-body text match: the plugin's own body is
 * ordinary JS in a `.cjs` file, so `eslint --fix` is free to reformat it
 * (quotes, semicolons, spacing) between when `add` wrote it and when
 * `upgrade` next runs — matching an exact prior version's text is exactly
 * the class of bug the compiler-swap fix above exists to prevent. Instead
 * this locates the plugin object by brace-counting from its own unique
 * `name` ({@link findEnclosingBraceSpan}) and replaces the WHOLE object with
 * the current version whenever {@link DECLARATION_SPECIFIER_DIRECTORY_MARKER}
 * is missing from it — regardless of what the old body's text actually was.
 * Checking the directory-aware marker rather than
 * {@link DECLARATION_SPECIFIER_EXTENSION_MARKER} is load-bearing: a project
 * `add`ed after the `.js`-extension capability shipped but before the
 * directory-barrel fix already carries the extension marker, so checking
 * that one would leave it stuck silently publishing untyped packages forever.
 *
 * Idempotent: a plugin that already carries the marker is left untouched.
 *
 * @param config - The rollup config's text.
 * @returns The config with the plugin upgraded in place, or unchanged when
 * there is no plugin to upgrade, it is already current, or its span could
 * not be found.
 * @throws Never — an unrecognised shape is returned unchanged.
 * @typeParam None - this function has no generic type parameters.
 */
export function withUpgradedDeclarationSpecifierPlugin (config: string): string {
  if (
    !config.includes(DECLARATION_SPECIFIER_PLUGIN_MARKER) ||
    config.includes(DECLARATION_SPECIFIER_DIRECTORY_MARKER)
  ) {
    return config
  }
  const span = findEnclosingBraceSpan(config, DECLARATION_SPECIFIER_PLUGIN_MARKER)
  if (!span) {
    return config
  }
  const [start, end] = span

  return `${config.slice(0, start)}${DECLARATION_SPECIFIER_PLUGIN}${config.slice(end)}`
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

/**
 * Replaces the stock README the Nx generators write.
 *
 * @remarks
 * Theirs credits Nx, which did not generate this project - mnci did, delegating one
 * step to an Nx generator. It also names the project by its directory rather than by
 * the package name the workspace actually publishes.
 *
 * The directory form is NOT broken: Nx resolves `nx build secrets` to `@auto/secrets`
 * happily. Checked, because the opposite was assumed first. Naming the package is
 * simply the less ambiguous of two working forms, and the one that matches what
 * `nx show projects` prints.
 *
 * @param projectRoot - Absolute path to the generated project's directory.
 * @param projectName - The Nx project name, which is the package name.
 * @param testRunner - The workspace test runner, named in the test command.
 * @returns Nothing.
 * @throws Propagates any `fs` error raised while writing.
 * @typeParam None - this function has no generic type parameters.
 */
export function writeProjectReadme (
  projectRoot: string,
  projectName: string,
  testRunner: WorkspaceStack['testRunner'],
): void {
  const runner = testRunner === 'vitest' ? '[Vitest](https://vitest.dev)' : '[Jest](https://jestjs.io)'
  writeFileEnsured(
    join(projectRoot, 'README.md'),
    [
      `# ${projectName}`,
      '',
      'Generated by [MoNecromanCI](https://github.com/russoedu/MoNecromanCi).',
      '',
      '## Building',
      '',
      `Run \`nx build ${projectName}\` to build this project.`,
      '',
      '## Running unit tests',
      '',
      `Run \`nx test ${projectName}\` to execute the unit tests via ${runner}.`,
      '',
    ].join('\n'),
  )
}

/**
 * Removes the `.gitkeep` a directory no longer needs.
 *
 * @remarks
 * `create-nx-workspace` drops one into `packages/` and `libs/` so git tracks them
 * while empty. Once a real project lands there the file is not just redundant, it is
 * misleading - it says "this directory is empty" in a directory that is not.
 *
 * Swept across every scaffold directory rather than the one an `add` just wrote to,
 * so a workspace that predates this picks up the tidy on its next add regardless of
 * which kind was added.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Never - a missing file is the expected case on every later add.
 * @typeParam None - this function has no generic type parameters.
 */
export function removeStaleGitkeeps (workspaceRoot: string): void {
  for (const scaffold of ['apps', 'libs', 'packages']) {
    const directory = join(workspaceRoot, scaffold)
    try {
      const holdsAProject = readdirSync(directory, { withFileTypes: true }).some((entry) =>
        entry.isDirectory(),
      )
      if (holdsAProject) {
        rmSync(join(directory, '.gitkeep'), { force: true })
      }
    } catch {
      // The scaffold directory does not exist in this workspace; nothing to sweep.
    }
  }
}

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

/**
 * Ensures the `adm-zip` packager is a workspace devDependency.
 *
 * @remarks
 * Each app's `package` target zips its build output with `adm-zip` (pure JS,
 * cross-platform, no native build) so CI can pack apps on any agent OS. Shared
 * by every app kind that packages its own output (react-app, the Python
 * kinds); the function-app path folds the same install into its larger one.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Error when the install exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
export function ensureAdmZip (workspaceRoot: string): void {
  if (hasPlugin(workspaceRoot, 'adm-zip')) {
    return
  }
  logger.step('Installing the app packager (adm-zip)')
  if (
    runShell(
      'npm',
      ['install', '--save-dev', 'adm-zip', '--no-audit', '--no-fund'],
      workspaceRoot,
    ) !== 0
  ) {
    throw new Error('npm install of adm-zip failed')
  }
}

/**
 * Derives the default npm scope from the workspace's root package name.
 *
 * @remarks
 * Shared by the function-app and npm-lib kinds — both fall back to the
 * workspace's own scope when no `--scope` is given.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The scope, e.g. `@demo` for a workspace named `demo` (or
 * `@demo/source`-style names produced by some presets).
 * @throws Propagates any `fs`/JSON error reading the root manifest.
 * @typeParam None - this function has no generic type parameters.
 */
export function defaultScope (workspaceRoot: string): string {
  const { name } = readJson<{ name: string }>(join(workspaceRoot, 'package.json'))
  const base = (name.startsWith('@') ? name.slice(1) : name).split('/', 1)[0]

  return `@${base}`
}

/**
 * Merges extra Nx targets into an inference-only app via its manifest `nx` field.
 *
 * @remarks
 * Apps generated by `@nx/react:app`/`@nx/node:application` have no
 * `project.json` (targets are inferred), so extra targets (e.g. per-environment
 * builds, a `package` target) are attached through the package.json `nx`
 * field — merged with the inferred targets, and free of the project-name
 * clash a second `project.json` would risk in a TS-solution workspace. Shared
 * by every inference-only app kind that adds targets this way (react-app,
 * node-app, node-function-app).
 *
 * @param manifestPath - Absolute path to the app's `package.json`.
 * @param newTargets - The targets to merge in.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
export function addNxTargets (manifestPath: string, newTargets: Record<string, unknown>): void {
  // The generator always writes this manifest first (runAdd throws otherwise);
  // defaulting to {} only guards the pathological missing-file case.
  const manifest = fileExists(manifestPath) ? readJson<Record<string, unknown>>(manifestPath) : {}
  const nx = (manifest.nx as Record<string, unknown> | undefined) ?? {}
  const targets = (nx.targets as Record<string, unknown> | undefined) ?? {}
  writeFileEnsured(
    manifestPath,
    toJson({ ...manifest, nx: { ...nx, targets: { ...targets, ...newTargets } } }),
  )
}

/**
 * Merges extra targets into a project's `project.json`, creating it if the
 * plugin that generated the project wrote none.
 *
 * @remarks
 * Was identical, hand-duplicated code in `go.ts`, `python.ts` and
 * `flutter.ts` — each of those plugins writes a real `project.json` (`go`'s
 * with an empty `targets` map, since `@nx-go/nx-go`'s own inference needs a
 * per-project `go.mod` mnci's single-root-module layout does not have; Python
 * and Flutter's carry their own lint/test/build already). Extracted once a
 * fourth caller needed it: `@nx/dotnet` is inference-only and writes no
 * `project.json` at all, so `csharp.ts` needs this to also CREATE one — the
 * one behavioural difference from the three hand-duplicated originals, which
 * could assume the file already existed. Tolerating a missing file is a
 * strict widening: the three existing callers are unaffected, since their
 * generators always write the file first.
 *
 * @param projectJsonPath - Absolute path to the project's `project.json`.
 * @param newTargets - The targets to merge in.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the file.
 * @typeParam None - this function has no generic type parameters.
 */
export function addProjectJsonTargets (
  projectJsonPath: string,
  newTargets: Record<string, unknown>,
): void {
  const project = fileExists(projectJsonPath)
    ? readJson<Record<string, unknown>>(projectJsonPath)
    : {}
  const targets = (project.targets as Record<string, unknown> | undefined) ?? {}
  writeFileEnsured(projectJsonPath, toJson({ ...project, targets: { ...targets, ...newTargets } }))
}

/**
 * Every ESLint flat-config filename an `@nx/*` generator might write.
 *
 * @remarks
 * Nx picks the extension from the project's module type, so all of these are
 * reachable across the kinds mnci generates.
 */
const ESLINT_CONFIG_FILENAMES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
] as const

/**
 * Deletes the per-project ESLint config an `@nx/*` generator just wrote, and
 * any `.vscode/` directory it re-created.
 *
 * @remarks
 * An mnci workspace has exactly ONE ESLint config, at the root
 * (`@mnci/eslint-config`). Every `@nx/*` generator nevertheless drops an
 * `eslint.config.mjs` into the project it creates, which re-fragments the
 * config the moment a project is added.
 *
 * Deleting them is safe, and that was verified rather than assumed: with no
 * per-project config a project still gets its inferred `lint` target from
 * `@nx/eslint/plugin` (which maps config directories to the project roots
 * beneath them), `nx lint <project>` still runs, and it still reports real
 * violations from the root config. The e2e asserts both halves permanently,
 * because a future Nx change to that inference is the one thing that would
 * silently turn linting off across a whole workspace.
 *
 * `.vscode/` is handled here too: `@nx/node` re-creates `launch.json` on every
 * `add`, so removing it once at `mnci new` would not be enough.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param projectRoot - The new project's path, relative to the workspace root
 * (e.g. `apps/web`).
 * @returns Nothing.
 * @throws Propagates any Node.js `fs` error other than a missing path.
 * @typeParam None - this function has no generic type parameters.
 */
export function removeGeneratedEslintConfig (workspaceRoot: string, projectRoot: string): void {
  for (const filename of ESLINT_CONFIG_FILENAMES) {
    rmSync(join(workspaceRoot, projectRoot, filename), { force: true })
  }
  rmSync(join(workspaceRoot, '.vscode'), { recursive: true, force: true })
}

/**
 * The local-dev commands a newly added project actually has, for {@link registerProjectCommands}.
 *
 * @remarks
 * `qa` (lint then test) is unconditional — every kind has both — so it is not
 * a field here. `build` and `start` vary by kind: several (`go-lib`,
 * `python-internal-lib`, `flutter-lib`, ...) have no build target at all, and
 * only kinds with a genuine local dev-server story get `start` — never a
 * library, and not `go-function-app` (no Azure Functions custom-handler
 * wiring exists for Go yet, so a `func start` script would just fail).
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface ProjectCommands {
  /** Whether this kind has a `build` Nx target — adds `<name>:build` when true. */
  build:  boolean
  /**
   * The exact command for `<name>:start` (e.g. `nx run <name>:serve`,
   * `nx run <name>:start`) — omitted entirely when the kind has no local
   * dev-server story.
   */
  start?: string
}

/**
 * Finds the workspace's single `<name>.code-workspace` file.
 *
 * @remarks
 * Its filename is the workspace name, which `add/*.ts` call sites don't
 * otherwise track past `mnci new` — cheaper to look it up by extension than
 * to thread the name through every kind module.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The absolute path, or `undefined` when none exists (a workspace
 * predating this file, or a test fixture that never wrote one).
 * @throws Never - a missing/unreadable directory yields `undefined`.
 * @typeParam None - this function has no generic type parameters.
 */
function findCodeWorkspaceFile (workspaceRoot: string): string | undefined {
  try {
    const entry = readdirSync(workspaceRoot).find(file => file.endsWith('.code-workspace'))

    return entry ? join(workspaceRoot, entry) : undefined
  } catch {
    return undefined
  }
}

/**
 * One VS Code task for a project's script, matching its root `package.json` entry.
 *
 * @remarks
 * `start` tasks run a dev server that never exits on its own, so they are
 * marked `isBackground` (VS Code won't wait for them to finish) rather than
 * given a `group` — `build`/`qa` do exit, so they get the matching group
 * VS Code's Command Palette/Tasks menu groups them under.
 *
 * @param name - The project name.
 * @param kind - Which of the three commands this task runs.
 * @returns The VS Code task object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function projectTask (name: string, kind: 'build' | 'qa' | 'start'): Record<string, unknown> {
  const script = `${name}:${kind}`
  const base = { label: `${name}: ${kind}`, type: 'npm', script, problemMatcher: [] }

  return kind === 'start' ? { ...base, isBackground: true } : { ...base, group: kind }
}

/**
 * Registers a newly added project's local-dev commands: root `package.json`
 * scripts, and matching VS Code tasks in the workspace's `.code-workspace` file.
 *
 * @remarks
 * Every `add/*.ts` kind function calls this once it has finished generating
 * and target-wiring a project, so `npm run <name>:build`/`:qa`/`:start` (and
 * the equivalent VS Code Command Palette entries) work immediately — no
 * separate `mnci upgrade` needed, since these are per-project entries, not
 * one of the fixed files `applyOverlay()` regenerates.
 *
 * `<name>:qa` (`nx run <name>:lint && nx run <name>:test`) is unconditional.
 * `<name>:build`/`<name>:start` are added only when {@link ProjectCommands}
 * says the kind actually has them. Idempotent: repeat calls for the same
 * `name` (a second `add` of the same project) overwrite rather than
 * duplicate, in both the manifest scripts and the `.code-workspace` tasks
 * array. A workspace with no `.code-workspace` file (predates it, or a test
 * fixture) still gets the `package.json` scripts — only the VS Code half is
 * skipped.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The newly added project's name.
 * @param commands - Which commands this kind actually has.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing either file.
 * @typeParam None - this function has no generic type parameters.
 */
export function registerProjectCommands (
  workspaceRoot: string,
  name: string,
  commands: ProjectCommands,
): void {
  // Every `add` kind ends here, which makes this the one place the scaffold
  // `.gitkeep` files can be swept without wiring 30 call sites.
  removeStaleGitkeeps(workspaceRoot)
  const scripts: Record<string, string> = {
    [`${name}:qa`]: `nx run ${name}:lint && nx run ${name}:test`,
  }
  if (commands.build) {
    scripts[`${name}:build`] = `nx run ${name}:build`
  }
  if (commands.start) {
    scripts[`${name}:start`] = commands.start
  }

  // Re-derived after every add, because whether the pip/pub blocks belong
  // depends on what projects now EXIST, and this add may have created the
  // first one. Cheap (a directory scan) and idempotent. Skipped when the
  // workspace has no dependabot.yml, i.e. it was generated with --ci=azure.
  const dependabotPath = join(workspaceRoot, '.github/dependabot.yml')
  if (existsSync(dependabotPath)) {
    writeFileEnsured(dependabotPath, dependabotConfig(workspaceRoot))
  }

  const manifestPath = join(workspaceRoot, 'package.json')
  const manifest = readJson<Record<string, unknown>>(manifestPath)
  const existingScripts = (manifest.scripts as Record<string, string> | undefined) ?? {}
  // Synced on EVERY add, not only the express one, because the override depends
  // on the manifest's state rather than on which generator just ran — and this
  // runs after that generator has written its dependencies. `mnci add node-app
  // --framework express` is what introduces express, and the very next add would
  // otherwise be the one that fails. See reactExpressPeerOverride for why it is
  // conditional and why an unconditional form is worse than the bug.
  const overrides = {
    ...(manifest.overrides as Record<string, unknown> | undefined),
    ...reactExpressPeerOverride(manifest),
  }
  writeFileEnsured(
    manifestPath,
    toJson({
      ...manifest,
      scripts: { ...existingScripts, ...scripts },
      ...((Object.keys(overrides).length > 0) && { overrides }),
    }),
  )

  const codeWorkspacePath = findCodeWorkspaceFile(workspaceRoot)
  if (!codeWorkspacePath) {
    return
  }
  const workspaceFile =
    readCodeWorkspace<{
      tasks?: { version?: string; tasks?: Record<string, unknown>[] }
    }>(codeWorkspacePath) ?? {}
  const label = (task: Record<string, unknown>): string => (task.label as string | undefined) ?? ''
  const existingTasks = (workspaceFile.tasks?.tasks ?? []).filter(
    task => !label(task).startsWith(`${name}: `),
  )
  const newTasks = [
    projectTask(name, 'qa'),
    ...(commands.build ? [projectTask(name, 'build')] : []),
    ...(commands.start ? [projectTask(name, 'start')] : []),
  ]
  writeFileEnsured(
    codeWorkspacePath,
    toJson({
      ...workspaceFile,
      tasks: {
        version: workspaceFile.tasks?.version ?? '2.0.0',
        tasks:   [...existingTasks, ...newTasks],
      },
    }),
  )
}

/** Where a generated project's own manifest can live, in resolution order. */
const PROJECT_MANIFEST_ROOTS = ['apps', 'packages', 'libs'] as const

/**
 * Reads the root manifest's runtime dependencies.
 *
 * @remarks
 * Snapshotted before a generator runs so {@link relocateRootRuntimeDependencies}
 * can attribute what it added.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The `dependencies` block, or an empty object when unreadable.
 * @throws Never - an unreadable manifest reads as empty.
 * @typeParam None - this function has no generic type parameters.
 */
export function rootRuntimeDependencies (workspaceRoot: string): Record<string, string> {
  try {
    return (
      readJson<{ dependencies?: Record<string, string> }>(join(workspaceRoot, 'package.json'))
        .dependencies ?? {}
    )
  } catch {
    return {}
  }
}

/**
 * Moves runtime dependencies a generator hoisted to the root into the project.
 *
 * @remarks
 * **The root/project policy, applied rather than only checked.** `mnci doctor`
 * gained a `no runtime dependencies in the root manifest` check, and a freshly
 * generated workspace failed it: `@nx/react:application` puts `react` and
 * `react-dom` in the ROOT manifest, `--framework=express` puts `express` there,
 * and `add node-function-app` installs `@azure/functions` the same way. So mnci
 * generated workspaces its own doctor rejected — the "a gate that fails on day
 * one" shape this repo has hit before.
 *
 * The reason the policy matters is `@nx/rollup`, which externalises exactly what
 * a project's OWN manifest declares: a dependency left at the root is not shared,
 * it is **inlined as a private copy** into that project's published bundle. The
 * root is also `private` and never published, so a consumer of `@scope/lib` can
 * never resolve it.
 *
 * **Attribution is by diff, not by guessing what a project imports.** Whatever
 * appeared in the root's `dependencies` while this generator ran belongs to the
 * project it just generated — accurate by construction, and it needs no import
 * analysis and no per-kind list to keep in sync as kinds are added.
 *
 * A value the project already declares **wins**: `add node-function-app` stamps
 * `@azure/functions` into the app manifest at the exact installed version, which
 * is more precise than the root's range.
 *
 * The lockfile is refreshed, because moving a dependency between manifests
 * leaves it stale. Measured: npm 10.9.7 runs `npm ci` against the stale lock
 * without complaint, which is leniency rather than correctness — the lock still
 * recorded the dependency against the root — and this repo has been bitten by
 * npm 10/11 divergence three times. A failure here warns rather than throws: the
 * project is already generated, and the remedy is one `npm install`.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param projectName - The project just generated.
 * @param before - The root `dependencies` snapshot taken before the generator ran.
 * @returns Nothing.
 * @throws Never - an unreadable or absent project manifest leaves the root alone.
 * @typeParam None - this function has no generic type parameters.
 */
export function relocateRootRuntimeDependencies (
  workspaceRoot: string,
  projectName: string,
  before: Record<string, string>,
): void {
  const after = rootRuntimeDependencies(workspaceRoot)
  const added = Object.keys(after).filter(name => !Object.hasOwn(before, name))
  if (added.length === 0) {
    return
  }

  const manifestPath = PROJECT_MANIFEST_ROOTS.map(root =>
    join(workspaceRoot, root, projectName, 'package.json'),
  ).find(candidate => fileExists(candidate))
  if (manifestPath === undefined) {
    // Nothing to move them INTO — a Python, Go or Dart project has no npm
    // manifest. Leaving the root untouched is the honest outcome: dropping the
    // declaration would break resolution for whatever does need it.
    return
  }

  const manifest = readJson<Record<string, unknown>>(manifestPath)
  const owned = (manifest.dependencies as Record<string, string> | undefined) ?? {}
  // `owned` is spread LAST so a value the project already declares wins, and
  // that ordering is the only mechanism enforcing it — filtering `moved` as
  // well would be a second, redundant guard that makes neither testable.
  const moved = Object.fromEntries(added.map(name => [name, after[name]]))
  writeFileEnsured(manifestPath, toJson({ ...manifest, dependencies: { ...moved, ...owned } }))

  const remaining = Object.fromEntries(
    Object.entries(after).filter(([name]) => !added.includes(name)),
  )
  const rootManifest = readJson<Record<string, unknown>>(join(workspaceRoot, 'package.json'))
  const { dependencies: _dropped, ...rest } = rootManifest
  writeFileEnsured(
    join(workspaceRoot, 'package.json'),
    toJson(Object.keys(remaining).length > 0 ? { ...rest, dependencies: remaining } : rest),
  )
  logger.step(`Moved ${added.join(', ')} into ${projectName}'s own manifest`)

  if (
    runShell(
      'npm',
      ['install', '--package-lock-only', '--no-audit', '--no-fund'],
      workspaceRoot,
    ) !== 0
  ) {
    logger.warn(
      `Could not refresh package-lock.json after moving ${added.join(', ')}. Run 'npm install'.`,
    )
  }
}
