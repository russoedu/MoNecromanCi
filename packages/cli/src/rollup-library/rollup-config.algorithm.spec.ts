import {
  canRepairRollupConfig,
  hasRollupSourceMaps,
  withRollupSourceMaps,
} from './rollup-config.algorithm'

describe('hasRollupSourceMaps', () => {
  it('matches the flag exactly as mnci writes it', () => {
    expect(hasRollupSourceMaps('    sourceMap: true,')).toBe(true)
  })

  it('tolerates the whitespace @stylistic/key-spacing (aligned on value) is entitled to add', () => {
    // The reproduction: an object whose longest key is `additionalEntryPoints`
    // gets every value column-aligned, so `sourceMap: true,` becomes
    // `sourceMap:             true,` - still the same flag, only reformatted.
    expect(hasRollupSourceMaps('    sourceMap:             true,')).toBe(true)
    expect(hasRollupSourceMaps('    sourceMap :   true')).toBe(true)
  })

  it('does not match the unrelated lowercase key in the placeholder comment', () => {
    // `// output: { sourcemap: true },` is Nx's own generated comment, and it
    // is genuinely a different key (rollup's own `sourcemap`, all lowercase) -
    // this must stay case-sensitive or every fresh project would read as
    // already fixed before mnci ever touches it.
    expect(hasRollupSourceMaps('    // output: { sourcemap: true },')).toBe(false)
  })

  it('reports false when the flag is genuinely absent', () => {
    expect(hasRollupSourceMaps("    compiler: 'swc',")).toBe(false)
  })
})

describe('canRepairRollupConfig', () => {
  it('is true for a config with the withNx two-argument boundary', () => {
    expect(canRepairRollupConfig('  },\n  {\n\n    format: ["esm"],\n  }\n)')).toBe(true)
  })

  it('is false for a one-line delegation to a shared base, which has no such boundary', () => {
    expect(canRepairRollupConfig("module.exports = require('../../rollup.base.cjs')()\n")).toBe(
      false,
    )
  })
})

describe('withRollupSourceMaps: idempotence after a lint reformat', () => {
  it('does not insert a second sourceMap: true into a config eslint has only reformatted', () => {
    // Reproduces the reported bug end to end: a config that already has source
    // maps on, reformatted by @stylistic/key-spacing (aligned on value) so the
    // flag now carries extra whitespace. A literal-string idempotence guard
    // would fail to recognise it and insert a duplicate flag; the fix is that
    // withRollupSourceMaps and its guard share the same whitespace-tolerant
    // check.
    const reformatted = [
      "const { withNx } = require('@nx/rollup/with-nx');",
      '',
      'module.exports = withNx(',
      '  {',
      "    main:                  './src/index.ts',",
      '    additionalEntryPoints: [],',
      "    outputPath:            './dist',",
      "    tsConfig:              './tsconfig.lib.json',",
      "    compiler:              'babel',",
      '    format:                ["esm"],',
      '    // Added by MoNecromanCI: without this rollup emits no .js.map at all, so',
      '    // a breakpoint in a .ts file can never bind. Not published - see `files`.',
      '    sourceMap:             true',
      '  },',
      '  {',
      '    // Provide additional rollup configuration here. See: https://rollupjs.org/configuration-options',
      '  }',
      ');',
    ].join('\n')

    const after = withRollupSourceMaps(reformatted)

    expect(after).toBe(reformatted)
    expect(after.match(/sourceMap/g)).toHaveLength(1)
  })
})

describe('withRollupSourceMaps: the compiler swap on a config eslint already reformatted', () => {
  it('still swaps swc for babel when key-spacing alignment padded the colon', () => {
    // The reported bug: a config that has never been repaired, but has been
    // through one `eslint --fix` pass (every mnci-generated file gets one) so
    // @stylistic/key-spacing padded every value out to the object's longest
    // key. A plain-string match on "    compiler: 'swc'," (one space) silently
    // stops matching the moment the padding changes that spacing - which is
    // exactly the shape `mnci upgrade` reaches when it finishes an `add` that
    // crashed after the generator wrote files but before mnci's own repair
    // ran. Reproduced end to end against a real generated workspace before
    // this test was written.
    const aligned = [
      "const { withNx } = require('@nx/rollup/with-nx')",
      '',
      'module.exports = withNx(',
      '  {',
      "    main:       './src/index.ts',",
      "    outputPath: './dist',",
      "    tsConfig:   './tsconfig.lib.json',",
      "    compiler:   'swc',",
      "    format:     ['esm'],",
      '  },',
      '  {',
      '    // Provide additional rollup configuration here. See: https://rollupjs.org/configuration-options',
      '  },',
      ')',
    ].join('\n')

    const after = withRollupSourceMaps(aligned)

    expect(after).toContain("compiler: 'babel',")
    expect(after).not.toMatch(/compiler:\s*'swc'/)
    expect(after).toMatch(/sourceMap\s*:\s*true\b/)
  })

  it('preserves the original indentation when swapping an aligned compiler line', () => {
    const deeplyIndented = [
      "const { withNx } = require('@nx/rollup/with-nx')",
      'module.exports = withNx(',
      '  {',
      '    additionalEntryPoints: [],',
      "    compiler:              'swc',",
      '  },',
      '  {',
      '  },',
      ')',
    ].join('\n')

    const after = withRollupSourceMaps(deeplyIndented)

    // The replacement's own lines (comment + compiler line) all start at the
    // same 4-space indent the original `compiler` line had - not 0, and not
    // whatever column the value happened to be aligned to.
    expect(after).toContain("\n    compiler: 'babel',")
    expect(after).not.toContain('\n babel')
  })
})
