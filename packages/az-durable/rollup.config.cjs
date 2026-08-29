const { withNx } = require('@nx/rollup/with-nx')

// Three entry points, deliberately separate:
// `./testing` and `./eslint-plugin` entry points are added in Phases 5 and 6,
// each with its `exports` entry, because an export naming a file that does not
// exist is the dangling-entry-point bug #158 fixed for npm-lib.
//
// ESM ONLY, though the build plan asked for dual CJS/ESM. `@nx/rollup` refuses
// CJS for a `"type": "module"` package — and its refusal is broken: it logs
// `Package type is set to "module" but "cjs" format is included. Going to use
// "esm" format instead` and then emits `index.cjs.js` regardless, because
// `finalConfig.output` is built from `options.format` BEFORE the package-type
// guard reassigns it. The emitted file is then unloadable: under
// `"type": "module"` a `.cjs.js` is parsed as ESM, has no `export` statements,
// and `require()` yields `{}` — verified, and verified fixed by renaming the
// identical bytes to `.cjs`.
//
// withNx cannot vary `entryFileNames` per format (one `output` object is spread
// into every format, and an array output is rejected outright), so dual output
// here means abandoning the mnci scaffold. Azure Functions v4 supports ESM, so
// ESM-only is the smaller cost. Revisit if a CJS consumer actually appears.
module.exports = withNx(
  {
    main: './src/index.ts',
    outputPath: './dist',
    tsConfig: './tsconfig.lib.json',
    compiler: 'swc',
    format: ['esm']
  },
  {}
)
