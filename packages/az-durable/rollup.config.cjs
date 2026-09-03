const { withNx } = require('@nx/rollup/with-nx')

// Three entry points, deliberately separate:
// `./testing` and `./eslint-plugin` are SEPARATE entry points: the harness must
// never enter a production bundle, and lint rules must never be a runtime
// import of the wrapper. Each was added together with its `exports` entry,
// because an export naming a file that does not exist is the
// dangling-entry-point bug #158 fixed for npm-lib.
//
// CJS ONLY, and the package carries no `type` field, so `.js` is CommonJS.
//
// One format rather than dual, because this package keeps module-level state:
// `registry.ts` holds the Map that makes duplicate activity/orchestration names
// throw. Those names are global to the Function App and silently misbind when
// duplicated, which is the whole reason that check exists. A dual package loaded
// both ways gets TWO registries, so a name registered once through each half
// passes the check designed to catch exactly that — the safety net failing
// silently. One format, one copy, one registry.
//
// CJS rather than ESM because it is the format both sides can load. An Azure
// Functions app on the default template is CommonJS, and Jest loads CJS with no
// transformIgnorePatterns; an ESM consumer still gets working named imports
// through Node's CJS interop, since rollup emits exports cjs-module-lexer can
// detect statically. Both directions are asserted by test/consumer (.cts and
// .mts), because that interop is a property of the BUILD, not of the source.
//
// The earlier note here said withNx cannot vary entryFileNames per format and
// that an array output is rejected. That is no longer true — withNx now returns
// an output ARRAY correctly differentiated per format — so dual output is
// mechanically available if the registry hazard above is ever solved (parking
// the Map on a globalThis symbol would do it).
module.exports = withNx(
  {
    main: './src/index.ts',
    additionalEntryPoints: ['./src/testing.ts', './src/eslint-plugin.ts'],
    outputPath: './dist',
    tsConfig: './tsconfig.lib.json',
    format: ['cjs'],
    // Was `compiler: 'swc'`. @nx/rollup runs swc via a plugin that calls
    // transform() WITHOUT sourceMaps, so swc returns no map, the rollup chain
    // breaks, and the bundle's map comes out structurally valid and
    // semantically empty - `sources: []`, every mapping segment blank. That is
    // indistinguishable from a working build right up until a breakpoint
    // refuses to bind. Measured here: swc gave 0 sources, babel gives 9, all
    // resolving, with sourcesContent. Revert once @nx/rollup passes sourceMaps
    // through - the upstream fix is one option in its plugins/swc.js.
    compiler: 'babel',
    // Without this rollup emits no .js.map at all, so a breakpoint in a .ts
    // file can never bind. Never published - see `files` in package.json.
    sourceMap: true
  },
  {
    output: {
      // rollup hands this an OS-native path with one parent segment too many:
      // for a map at dist/index.cjs.js.map whose source is src/index.ts it
      // passes a path resolving to <packages>/src/index.ts, which does not
      // exist. Both halves are repaired - the separator, because a sourcemap
      // `sources` entry is URL-style so a backslash is wrong on every platform
      // (the same bug class as the declaration stub below), and the depth, by
      // collapsing the leading parent-segment run to exactly one. A collapse
      // rather than a fixed prefix, so it cannot go stale at another depth.
      sourcemapPathTransform: relativeSourcePath =>
        relativeSourcePath.replaceAll(String.fromCodePoint(92), '/').replace(/^(\.\.\/)+/, '../')
    }
  }
)
