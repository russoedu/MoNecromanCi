// `withUpgradedDeclarationSpecifierPlugin` is a pure transform and would
// otherwise belong beside `rollup-config.algorithm.ts`. It is tested here
// because it shares OLD_DTS_PLUGIN_CONFIG, EXTENSION_ONLY_DTS_PLUGIN_CONFIG
// and loadWriteBundle with the repairs that apply it, and duplicating those
// fixtures across two spec files would be the worse trade. Recorded as an
// exception in packages/cli/README.md.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withUpgradedDeclarationSpecifierPlugin } from './rollup-config.algorithm'
import { repairDeclarationSpecifiers, upgradeDeclarationSpecifierPlugins } from './repair-rollup-config.use-case'

let workspaceRoot: string

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-rollup-repair-'))
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@demo/source' }))
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

/**
 * Requires the rollup config `repairDeclarationSpecifiers` wrote, with a stub
 * `@nx/rollup/with-nx` so the real plugin object underneath is reachable
 * without pulling in the real rollup toolchain. Returns a function that
 * invokes the config's dts-fix plugin's real `writeBundle(outputOptions)` —
 * the actual code that runs at build time, not a description of it.
 */
function loadWriteBundle (projectRoot: string): (outputOptions: { dir: string }) => void {
  const nodeModulesDir = join(projectRoot, 'node_modules', '@nx', 'rollup')
  mkdirSync(nodeModulesDir, { recursive: true })
  writeFileSync(
    join(nodeModulesDir, 'with-nx.js'),
    'module.exports.withNx = (first, second) => ({ first, second })',
  )
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loading a real generated .cjs file is the point of this test
  const config = require(join(projectRoot, 'rollup.config.cjs')) as {
    second: { plugins: { writeBundle (outputOptions: { dir: string }): void }[] }
  }

  return outputOptions => config.second.plugins[0].writeBundle(outputOptions)
}

describe('repairDeclarationSpecifiers: extensionless declaration re-exports under nodenext', () => {
  it('appends .js to a bare relative specifier in the real declarations, not just the stub', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mnci-dts-fix-'))
    writeFileSync(
      join(projectRoot, 'rollup.config.cjs'),
      [
        "const { withNx } = require('@nx/rollup/with-nx')",
        'module.exports = withNx(',
        '  {',
        "    main: './src/index.ts',",
        '  },',
        '  {',
        '    // Provide additional rollup configuration here. See: https://rollupjs.org/configuration-options',
        '    // e.g.',
        '    // output: { sourcemap: true },',
        '  }',
        ')',
      ].join('\n'),
    )

    repairDeclarationSpecifiers(projectRoot)

    const distDir = join(projectRoot, 'dist')
    mkdirSync(join(distDir, 'src', 'lib'), { recursive: true })
    writeFileSync(join(distDir, 'index.d.ts'), 'export * from "./src/index";')
    writeFileSync(join(distDir, 'src', 'index.d.ts'), "export * from './lib/align';\n")
    writeFileSync(
      join(distDir, 'src', 'lib', 'align.d.ts'),
      'export declare function align(xs: number[]): number[];\n',
    )

    loadWriteBundle(projectRoot)({ dir: distDir })

    expect(readFileSync(join(distDir, 'index.d.ts'), 'utf8')).toBe('export * from "./src/index.js";')
    expect(readFileSync(join(distDir, 'src', 'index.d.ts'), 'utf8')).toBe(
      "export * from './lib/align.js';\n",
    )
    // A file with no relative export at all is left byte-for-byte alone.
    expect(readFileSync(join(distDir, 'src', 'lib', 'align.d.ts'), 'utf8')).toBe(
      'export declare function align(xs: number[]): number[];\n',
    )
  })

  it('resolves a bare specifier naming a directory barrel to /index.js, not .js', () => {
    // The actual bug: a directory barrel has no <name>.d.ts sibling, only
    // <name>/index.d.ts. Appending .js unconditionally names a file rollup
    // never emitted; ESM resolution has no directory-index fallback, so
    // TypeScript cannot resolve it and (with skipLibCheck, the default in
    // most consumers) silently degrades the whole module to `any` instead
    // of erroring. Confirmed against a real published tarball.
    const projectRoot = mkdtempSync(join(tmpdir(), 'mnci-dts-fix-'))
    writeFileSync(
      join(projectRoot, 'rollup.config.cjs'),
      [
        "const { withNx } = require('@nx/rollup/with-nx')",
        'module.exports = withNx(',
        '  {',
        "    main: './src/index.ts',",
        '  },',
        '  {',
        '    // Provide additional rollup configuration here. See: https://rollupjs.org/configuration-options',
        '    // e.g.',
        '    // output: { sourcemap: true },',
        '  }',
        ')',
      ].join('\n'),
    )

    repairDeclarationSpecifiers(projectRoot)

    const distDir = join(projectRoot, 'dist')
    mkdirSync(join(distDir, 'scan-session'), { recursive: true })
    // Root barrel re-exports a directory, not a file.
    writeFileSync(join(distDir, 'index.d.ts'), "export * from './scan-session';\n")
    writeFileSync(
      join(distDir, 'scan-session', 'index.d.ts'),
      'export declare function scan(): void;\n',
    )

    loadWriteBundle(projectRoot)({ dir: distDir })

    expect(readFileSync(join(distDir, 'index.d.ts'), 'utf8')).toBe(
      "export * from './scan-session/index.js';\n",
    )
  })

  it('leaves a bare specifier alone when neither a file nor a directory barrel exists for it', () => {
    // Nothing was emitted under this name at all (a type-only export, a
    // build that hasn't run for this entry yet, …) — rewriting it to a
    // guessed suffix would produce a specifier that resolves to nothing,
    // strictly worse than leaving the original text in place.
    const projectRoot = mkdtempSync(join(tmpdir(), 'mnci-dts-fix-'))
    writeFileSync(
      join(projectRoot, 'rollup.config.cjs'),
      [
        "const { withNx } = require('@nx/rollup/with-nx')",
        'module.exports = withNx(',
        '  {',
        "    main: './src/index.ts',",
        '  },',
        '  {',
        '    // Provide additional rollup configuration here. See: https://rollupjs.org/configuration-options',
        '    // e.g.',
        '    // output: { sourcemap: true },',
        '  }',
        ')',
      ].join('\n'),
    )

    repairDeclarationSpecifiers(projectRoot)

    const distDir = join(projectRoot, 'dist')
    mkdirSync(distDir, { recursive: true })
    const unresolvable = "export * from './nothing-here';\n"
    writeFileSync(join(distDir, 'index.d.ts'), unresolvable)

    loadWriteBundle(projectRoot)({ dir: distDir })

    expect(readFileSync(join(distDir, 'index.d.ts'), 'utf8')).toBe(unresolvable)
  })

  it('never double-appends an extension a specifier already has', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'mnci-dts-fix-'))
    writeFileSync(
      join(projectRoot, 'rollup.config.cjs'),
      [
        "const { withNx } = require('@nx/rollup/with-nx')",
        'module.exports = withNx(',
        '  {',
        "    main: './src/index.ts',",
        '  },',
        '  {',
        '    // Provide additional rollup configuration here. See: https://rollupjs.org/configuration-options',
        '    // e.g.',
        '    // output: { sourcemap: true },',
        '  }',
        ')',
      ].join('\n'),
    )

    repairDeclarationSpecifiers(projectRoot)

    const distDir = join(projectRoot, 'dist')
    mkdirSync(distDir, { recursive: true })
    const alreadyExplicit = "export * from './lib/align.js';\n"
    writeFileSync(join(distDir, 'index.d.ts'), alreadyExplicit)

    loadWriteBundle(projectRoot)({ dir: distDir })

    expect(readFileSync(join(distDir, 'index.d.ts'), 'utf8')).toBe(alreadyExplicit)
  })
})

/**
 * A real rollup config carrying the declaration-specifier plugin exactly as
 * it was written before the `.js`-extension capability existed — the shape
 * `mnci upgrade` needs to find and upgrade in place — genuinely older text
 * (fewer lines, no extension-fix code at all), not a byte-identical copy of
 * the current plugin body. That is the property
 * {@link withUpgradedDeclarationSpecifierPlugin} must hold regardless of
 * exactly how an old body reads: it locates the plugin by brace-counting
 * from its unique, mnci-owned `name` string (kept single-quoted here, as
 * `eslint --fix` would leave it — Standard prefers single quotes, which is
 * what mnci already writes), not by matching the old body's full text.
 */
const OLD_DTS_PLUGIN_CONFIG = [
  'const { withNx } = require("@nx/rollup/with-nx");',
  '',
  'module.exports = withNx(',
  '  {',
  '    main: "./src/index.ts",',
  '    outputPath: "./dist",',
  '    tsConfig: "./tsconfig.lib.json",',
  '    compiler: "babel",',
  '    format: ["esm"],',
  '    sourceMap: true',
  '  },',
  '  {',
  '    output: {',
  '      sourcemapPathTransform: (relativeSourcePath) =>',
  String.raw`        relativeSourcePath.replaceAll(String.fromCodePoint(92), "/").replace(/^(\.\.\/)+/, "../")`,
  '    },',
  '    plugins: [',
  '      {',
  "        name: 'mnci-normalise-declaration-specifiers',",
  '        writeBundle(outputOptions) {',
  '          const { readFileSync, writeFileSync } = require("node:fs");',
  '          const { join } = require("node:path");',
  '          const stub = join(outputOptions.dir ?? "./dist", "index.d.ts");',
  '          let source;',
  '          try {',
  '            source = readFileSync(stub, "utf8");',
  '          } catch {',
  '            return;',
  '          }',
  '          const separator = String.fromCodePoint(92, 92);',
  '          const normalised = source.replaceAll(separator, "/");',
  '          if (normalised !== source) writeFileSync(stub, normalised);',
  '        }',
  '      }',
  '    ]',
  '  }',
  ');',
].join('\n')

/**
 * A rollup config carrying the plugin body exactly as it read after the
 * `.js`-extension capability shipped but BEFORE the directory-barrel fix —
 * i.e. it already contains {@link DECLARATION_SPECIFIER_EXTENSION_MARKER}
 * but not {@link DECLARATION_SPECIFIER_DIRECTORY_MARKER}. This is the real
 * regression a bug report against a consuming workspace found: nine of
 * eleven packages carried this exact generation, silently publishing
 * untyped declarations for any directory barrel, and nothing ever revisited
 * them because the old upgrade check only looked for the extension marker,
 * which they already had.
 */
const EXTENSION_ONLY_DTS_PLUGIN_CONFIG = [
  'const { withNx } = require("@nx/rollup/with-nx");',
  '',
  'module.exports = withNx(',
  '  {',
  '    main: "./src/index.ts",',
  '  },',
  '  {',
  '    plugins: [',
  '      {',
  "        name: 'mnci-normalise-declaration-specifiers',",
  '        writeBundle(outputOptions) {',
  '          const { readdirSync, readFileSync, writeFileSync } = require("node:fs");',
  '          const { join } = require("node:path");',
  '          const dir = outputOptions.dir ?? "./dist";',
  '          const stub = join(dir, "index.d.ts");',
  '          let source;',
  '          try {',
  '            source = readFileSync(stub, "utf8");',
  '          } catch {',
  '            return;',
  '          }',
  '          const separator = String.fromCodePoint(92, 92);',
  '          const normalised = source.replaceAll(separator, "/");',
  '          if (normalised !== source) writeFileSync(stub, normalised);',
  String.raw`          const bareRelativeSpecifier = /from(\s+)(['"])(\.[^'"]+?)\2/g;`,
  String.raw`          const hasExtension = /\.(?:mjs|cjs|jsx?|json)$/;`,
  '          let entries;',
  '          try {',
  '            entries = readdirSync(dir, { recursive: true, withFileTypes: true });',
  '          } catch {',
  '            return;',
  '          }',
  '          for (const entry of entries) {',
  '            if (!entry.name.endsWith(".d.ts")) continue;',
  '            const filePath = join(entry.parentPath ?? entry.path, entry.name);',
  '            let declaration;',
  '            try {',
  '              declaration = readFileSync(filePath, "utf8");',
  '            } catch {',
  '              continue;',
  '            }',
  '            const withExtensions = declaration.replace(',
  '              bareRelativeSpecifier,',
  '              (match, space, quote, specifier) =>',
  '                hasExtension.test(specifier) ? match : `from${space}${quote}${specifier}.js${quote}`,',
  '            );',
  '            if (withExtensions !== declaration) writeFileSync(filePath, withExtensions);',
  '          }',
  '        }',
  '      }',
  '    ]',
  '  }',
  ');',
].join('\n')

describe('withUpgradedDeclarationSpecifierPlugin', () => {
  it('upgrades an old plugin body to the current one, regardless of its exact prior text', () => {
    const after = withUpgradedDeclarationSpecifierPlugin(OLD_DTS_PLUGIN_CONFIG)

    expect(after).toContain('bareRelativeSpecifier')
    expect(after).toContain("name: 'mnci-normalise-declaration-specifiers'")
    // Nothing outside the plugin object moved.
    expect(after).toContain('sourcemapPathTransform')
    expect(after).toContain('compiler: "babel"')
  })

  it('is idempotent — a config already carrying the marker is untouched', () => {
    const current = withUpgradedDeclarationSpecifierPlugin(OLD_DTS_PLUGIN_CONFIG)

    expect(withUpgradedDeclarationSpecifierPlugin(current)).toBe(current)
  })

  it('upgrades a config that already has the extension fix but not the directory-barrel fix', () => {
    // The real regression: this generation already contains
    // DECLARATION_SPECIFIER_EXTENSION_MARKER, so the OLD upgrade check
    // (extension marker present => "already current") left it untouched
    // forever. It must be recognised as stale and upgraded here too.
    const after = withUpgradedDeclarationSpecifierPlugin(EXTENSION_ONLY_DTS_PLUGIN_CONFIG)

    expect(after).toContain('resolveSpecifierSuffix')
    expect(after).not.toBe(EXTENSION_ONLY_DTS_PLUGIN_CONFIG)
  })

  it('an upgraded extension-only config actually resolves a directory barrel correctly', () => {
    // Not just "the marker is present" - the upgraded body must really run
    // and really fix the bug, proven by loading and executing it for real.
    const projectRoot = mkdtempSync(join(tmpdir(), 'mnci-dts-upgrade-'))
    writeFileSync(
      join(projectRoot, 'rollup.config.cjs'),
      withUpgradedDeclarationSpecifierPlugin(EXTENSION_ONLY_DTS_PLUGIN_CONFIG),
    )

    const distDir = join(projectRoot, 'dist')
    mkdirSync(join(distDir, 'scan-session'), { recursive: true })
    writeFileSync(join(distDir, 'index.d.ts'), "export * from './scan-session';\n")
    writeFileSync(
      join(distDir, 'scan-session', 'index.d.ts'),
      'export declare function scan(): void;\n',
    )

    loadWriteBundle(projectRoot)({ dir: distDir })

    expect(readFileSync(join(distDir, 'index.d.ts'), 'utf8')).toBe(
      "export * from './scan-session/index.js';\n",
    )
  })

  it('leaves a config with no declaration-specifier plugin at all unchanged', () => {
    const config = "module.exports = withNx({ main: './src/index.ts' }, {})\n"

    expect(withUpgradedDeclarationSpecifierPlugin(config)).toBe(config)
  })
})

describe('upgradeDeclarationSpecifierPlugins', () => {
  it('upgrades every old plugin under packages/ and libs/, and reports what changed', () => {
    mkdirSync(join(workspaceRoot, 'packages/align'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'libs/design'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'packages/align/rollup.config.cjs'), OLD_DTS_PLUGIN_CONFIG)
    writeFileSync(join(workspaceRoot, 'libs/design/rollup.config.cjs'), OLD_DTS_PLUGIN_CONFIG)

    const changed = upgradeDeclarationSpecifierPlugins(workspaceRoot)

    expect(changed).toHaveLength(2)
    expect(changed).toEqual(
      expect.arrayContaining(['libs/design/rollup.config.cjs', 'packages/align/rollup.config.cjs']),
    )
    expect(readFileSync(join(workspaceRoot, 'packages/align/rollup.config.cjs'), 'utf8')).toContain(
      'bareRelativeSpecifier',
    )
  })

  it('reports nothing changed on a repeat run', () => {
    mkdirSync(join(workspaceRoot, 'packages/align'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'packages/align/rollup.config.cjs'), OLD_DTS_PLUGIN_CONFIG)
    upgradeDeclarationSpecifierPlugins(workspaceRoot)

    expect(upgradeDeclarationSpecifierPlugins(workspaceRoot)).toEqual([])
  })
})
