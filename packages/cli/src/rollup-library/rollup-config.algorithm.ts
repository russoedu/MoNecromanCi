/**
 * The rollup config text a generated library carries: what it looks like when it
 * is correct, and what to change when it is not.
 *
 * @remarks
 * Every transform here is pure and deterministic - it takes config text and
 * returns config text, and touches no filesystem. The reads and writes live in
 * the sibling repository and use-case files.
 */

/**
 * The empty second-argument slot `@nx/js:lib --bundler=rollup` writes verbatim.
 *
 * @remarks
 * Matched exactly, as the generator emits it, and used as the anchor every
 * declaration repair splices into. A config that no longer carries it has
 * either been repaired already or been edited by hand, and in both cases the
 * repair must leave it alone rather than guess at a new insertion point.
 */
export const ROLLUP_CONFIG_PLACEHOLDER = [
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

/**
 * The same slot, carrying a plugin that repairs the declaration stub.
 *
 * @remarks
 * What {@link ROLLUP_CONFIG_PLACEHOLDER} is replaced with: the mnci-owned
 * rollup plugin, inline in the generated config rather than imported from a
 * package, so a generated workspace needs nothing published to build.
 */
export const ROLLUP_CONFIG_WITH_DTS_FIX = [
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
