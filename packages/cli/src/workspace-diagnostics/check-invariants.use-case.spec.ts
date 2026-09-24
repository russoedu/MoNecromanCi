// Mocked because this spec reaches a sibling slice through its barrel, which
// transitively loads @inquirer/prompts — ESM-only, and unparseable by jest
// as CJS. Nothing here exercises a prompt; every other spec that touches
// this module mocks it the same way.
jest.mock('@inquirer/prompts', () => ({ confirm: jest.fn(), input: jest.fn(), select: jest.fn(), checkbox: jest.fn(), Separator: class {} }))
// nx sync:check is the one check that shells out. Mocked so the suite neither
// needs a real Nx graph nor pays for a subprocess per test; the sync finding is
// asserted through the mock's return code instead.
jest.mock('../nx-workspace', () => ({ runShell: jest.fn(() => 0) }))

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runShell } from '../nx-workspace'
import { repairDeclarationSpecifiers, upgradeDeclarationSpecifierPlugins } from '../rollup-library'
import { collectFindings, runDoctor, type Finding } from './check-invariants.use-case'

const mockRunShell = jest.mocked(runShell)

let workspaceRoot: string

/** A workspace where every invariant holds, for tests to break one at a time. */
function seedHealthyWorkspace (): void {
  writeFileSync(
    join(workspaceRoot, 'nx.json'),
    JSON.stringify({
      plugins: [{ plugin: '@nx/eslint/plugin', options: { targetName: 'lint' } }],
      mnci:    { registry: { kind: 'npm' }, scope: '@demo' },
    }),
  )
  writeFileSync(join(workspaceRoot, 'eslint.config.mjs'), 'export default []')
  // No formatter config: ESLint is the formatter, and every Prettier/oxfmt file
  // is now something `checkNoRetiredFormatter` reports.
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ devDependencies: {} }))
  writeFileSync(
    join(workspaceRoot, '.npmrc'),
    '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n',
  )
}

/**
 * Seeds a healthy workspace whose manifest declares exactly `devDependencies`.
 *
 * @param devDependencies - The manifest's declared devDependencies.
 */
function writeWorkspace (devDependencies: Record<string, string> = {}): void {
  seedHealthyWorkspace()
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ devDependencies }))
}

const findingFor = (findings: Finding[], fragment: string): Finding | undefined =>
  findings.find(finding => finding.check.includes(fragment))

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-doctor-'))
  mockRunShell.mockImplementation(() => 0)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
  process.exitCode = undefined
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
  process.exitCode = undefined
})

describe('collectFindings', () => {
  it('throws outside a workspace, rather than reporting everything as broken', () => {
    expect(() => collectFindings(workspaceRoot)).toThrow('No nx.json found')
  })

  it('passes every check on a healthy workspace', () => {
    seedHealthyWorkspace()

    expect(collectFindings(workspaceRoot).filter(finding => !finding.ok)).toEqual([])
  })

  it('catches a per-project ESLint config, the fragmentation the root config exists to end', () => {
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'packages/sdk'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'packages/sdk/eslint.config.mjs'), 'export default []')

    const finding = findingFor(collectFindings(workspaceRoot), 'no per-project ESLint')

    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('packages/sdk/eslint.config.mjs')
    expect(finding?.remedy).toContain('mnci upgrade')
  })

  it('catches a missing root ESLint config', () => {
    seedHealthyWorkspace()
    rmSync(join(workspaceRoot, 'eslint.config.mjs'))

    expect(findingFor(collectFindings(workspaceRoot), 'root ESLint config')?.ok).toBe(false)
  })

  it('says nothing about the split on a workspace that has not been upgraded to it', () => {
    // eslint.config.mnci.mjs is what upgrade writes. Until it exists there is
    // nothing for the entry point to import, and nagging about a file the
    // workspace has never had would be noise on every older workspace.
    seedHealthyWorkspace()

    expect(findingFor(collectFindings(workspaceRoot), 'imports the mnci rules')).toBeUndefined()
  })

  it('catches an entry point that has stopped importing the mnci rules', () => {
    // The failure is silent, which is why it is worth a check: ESLint is happy
    // with a config carrying no rules, so `lint` passes and every file in the
    // repository drifts. mnci cannot fix this itself — it does not rewrite this
    // file, which is the entire point of the split — so the remedy has to say
    // what to type.
    seedHealthyWorkspace()
    writeFileSync(join(workspaceRoot, 'eslint.config.mnci.mjs'), 'export default []')
    writeFileSync(join(workspaceRoot, 'eslint.config.mjs'), 'export default []')

    const finding = findingFor(collectFindings(workspaceRoot), 'imports the mnci rules')

    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('never mentions')
    expect(finding?.remedy).toContain("import mnci from './eslint.config.mnci.mjs'")
  })

  it('passes once the entry point imports them', () => {
    seedHealthyWorkspace()
    writeFileSync(join(workspaceRoot, 'eslint.config.mnci.mjs'), 'export default []')
    writeFileSync(
      join(workspaceRoot, 'eslint.config.mjs'),
      "import mnci from './eslint.config.mnci.mjs'\nexport default [...mnci]\n",
    )

    expect(findingFor(collectFindings(workspaceRoot), 'imports the mnci rules')?.ok).toBe(true)
  })

  it('catches an unregistered @nx/eslint/plugin, which makes lint pass while linting nothing', () => {
    seedHealthyWorkspace()
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ plugins: [] }))

    expect(findingFor(collectFindings(workspaceRoot), '@nx/eslint/plugin')?.ok).toBe(false)
  })

  it('accepts the bare-string plugin form Nx also allows', () => {
    seedHealthyWorkspace()
    writeFileSync(
      join(workspaceRoot, 'nx.json'),
      JSON.stringify({ plugins: ['@nx/eslint/plugin'] }),
    )

    expect(findingFor(collectFindings(workspaceRoot), '@nx/eslint/plugin')?.ok).toBe(true)
  })

  it('catches a resolved eslint major outside the supported one — the drift that shipped', () => {
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'node_modules/eslint'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'node_modules/eslint/package.json'),
      JSON.stringify({ name: 'eslint', version: '9.39.5' }),
    )

    const finding = findingFor(collectFindings(workspaceRoot), 'resolved eslint')

    // The real bug: manifests declared one major while the docs said another,
    // and only the INSTALLED version revealed it. The majors have since swapped
    // — the stack is on 10 now — and the check follows ESLINT_VERSION rather
    // than a literal, which is exactly why only these fixtures needed changing.
    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('9.39.5')
  })

  it('passes when the resolved eslint is the supported major', () => {
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'node_modules/eslint'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'node_modules/eslint/package.json'),
      JSON.stringify({ name: 'eslint', version: '10.8.0' }),
    )

    expect(findingFor(collectFindings(workspaceRoot), 'resolved eslint')?.ok).toBe(true)
  })

  it('skips the eslint check entirely when nothing is installed', () => {
    seedHealthyWorkspace()

    // "not installed yet" is not drift, and reporting it as a failure would train
    // people to ignore the output.
    expect(findingFor(collectFindings(workspaceRoot), 'resolved eslint')).toBeUndefined()
  })

  it('passes when the root manifest declares no runtime dependency', () => {
    seedHealthyWorkspace()

    expect(findingFor(collectFindings(workspaceRoot), 'no runtime dependencies')?.ok).toBe(true)
  })

  it('catches a runtime dependency hoisted to the root manifest', () => {
    // The axios failure, in miniature. The root is private and never published,
    // and @nx/rollup externalises only what a project's OWN manifest declares —
    // so hoisting a dependency here does not share it, it makes rollup inline a
    // private copy into the published bundle.
    seedHealthyWorkspace()
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({ dependencies: { axios: '^1.9.0' }, devDependencies: {} }),
    )

    const finding = findingFor(collectFindings(workspaceRoot), 'no runtime dependencies')
    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('axios')
    // A finding the user cannot act on is noise — the remedy has to name it.
    expect(finding?.remedy).toContain('axios')
  })

  it('says nothing about devDependencies at the root, which is what the root is for', () => {
    seedHealthyWorkspace()
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({ devDependencies: { eslint: '^10.8.1', jest: '^30.0.0' } }),
    )

    expect(findingFor(collectFindings(workspaceRoot), 'no runtime dependencies')?.ok).toBe(true)
  })

  it('catches an .npmrc that cannot authenticate a public-npm publish', () => {
    seedHealthyWorkspace()
    writeFileSync(join(workspaceRoot, '.npmrc'), '; nothing here\n')

    expect(findingFor(collectFindings(workspaceRoot), '.npmrc authenticates')?.ok).toBe(false)
  })

  it('requires scope routing on an azure-artifacts workspace', () => {
    seedHealthyWorkspace()
    writeFileSync(
      join(workspaceRoot, 'nx.json'),
      JSON.stringify({
        plugins: ['@nx/eslint/plugin'],
        mnci:    {
          scope:    '@demo',
          registry: {
            kind:          'azure-artifacts',
            organization:  'org',
            project:       'proj',
            artifactsFeed: 'feed',
          },
        },
      }),
    )
    // A public-npm .npmrc in an Azure workspace: a scoped package would publish
    // to npmjs.org instead of the feed.
    const finding = findingFor(collectFindings(workspaceRoot), 'routes the scope')

    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('@demo')
  })

  it('catches a publishable Dart package missing its versionActions override', () => {
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'packages/shared'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'packages/shared/pubspec.yaml'), 'name: shared\n')
    writeFileSync(join(workspaceRoot, 'packages/shared/project.json'), JSON.stringify({}))

    const finding = findingFor(collectFindings(workspaceRoot), 'packages/shared')

    // The highest-consequence check: without the override, nx release aborts for
    // every project in the workspace, not just this one.
    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('ENTIRE workspace')
  })

  it('passes a Dart package that keeps the override', () => {
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'packages/shared'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'packages/shared/pubspec.yaml'), 'name: shared\n')
    writeFileSync(
      join(workspaceRoot, 'packages/shared/project.json'),
      JSON.stringify({
        release: { version: { versionActions: '@mnci/nx-flutter/release/version-actions' } },
      }),
    )

    expect(findingFor(collectFindings(workspaceRoot), 'packages/shared')?.ok).toBe(true)
  })

  it('catches a publishable C# package missing its versionActions override', () => {
    // csharp-lib is the only C# kind that lands in packages/, so it sits
    // inside release.projects and carries the same whole-workspace failure
    // mode as a Dart or Python one — it just resolves its override to a
    // workspace-relative .cjs rather than to a plugin.
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'packages/cslib'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'packages/cslib/cslib.csproj'), '<Project />\n')
    writeFileSync(join(workspaceRoot, 'packages/cslib/project.json'), JSON.stringify({}))

    const finding = findingFor(collectFindings(workspaceRoot), 'packages/cslib')

    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('ENTIRE workspace')
  })

  it('passes a C# package that keeps the override', () => {
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'packages/cslib'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'packages/cslib/cslib.csproj'), '<Project />\n')
    writeFileSync(
      join(workspaceRoot, 'packages/cslib/project.json'),
      JSON.stringify({
        release: { version: { versionActions: './tools/csharp-version-actions.cjs' } },
      }),
    )

    expect(findingFor(collectFindings(workspaceRoot), 'packages/cslib')?.ok).toBe(true)
  })

  it('catches a build target whose main names a file that was never written', () => {
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'apps/api/src'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'apps/api/project.json'),
      JSON.stringify({
        targets: { build: { options: { main: 'apps/api/src/index.ts' } } },
      }),
    )

    const finding = findingFor(collectFindings(workspaceRoot), 'build.main')

    // Nx never validates this, so the build fails as a compiler error about
    // finding no inputs — and nothing names the file that is actually missing.
    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('apps/api/src/index.ts')
    expect(finding?.remedy).toContain('apps/api/project.json')
  })

  it('reads targets from BOTH project.json and package.json, so a stale one cannot hide', () => {
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'apps/api/src'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/api/src/index.ts'), 'export {}')
    // The real shape this came from: project.json's main exists, package.json's
    // does not, and the two disagree about what the entry point even is.
    writeFileSync(
      join(workspaceRoot, 'apps/api/project.json'),
      JSON.stringify({ targets: { build: { options: { main: 'apps/api/src/index.ts' } } } }),
    )
    writeFileSync(
      join(workspaceRoot, 'apps/api/package.json'),
      JSON.stringify({
        name: '@demo/api',
        nx:   { targets: { build: { options: { main: 'apps/api/src/main.ts' } } } },
      }),
    )

    const findings = collectFindings(workspaceRoot).filter(f => f.check.includes('build.main'))

    expect(findings).toHaveLength(1)
    expect(findings[0]?.check).toContain('package.json')
    expect(findings[0]?.detail).toContain('apps/api/src/main.ts')
  })

  it('catches a tsConfig naming a tsconfig that does not exist', () => {
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'libs/models/src'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'libs/models/src/index.ts'), 'export {}')
    writeFileSync(
      join(workspaceRoot, 'libs/models/project.json'),
      JSON.stringify({
        targets: {
          build: {
            options: { main: 'libs/models/src/index.ts', tsConfig: 'libs/models/tsconfig.lib.json' },
          },
        },
      }),
    )

    expect(findingFor(collectFindings(workspaceRoot), 'build.tsConfig')?.ok).toBe(false)
  })

  it('passes targets whose files exist, and never resolves an Nx token literally', () => {
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'apps/api/src'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/api/src/main.ts'), 'export {}')
    writeFileSync(join(workspaceRoot, 'apps/api/tsconfig.json'), '{}')
    writeFileSync(
      join(workspaceRoot, 'apps/api/project.json'),
      JSON.stringify({
        targets: {
          build: {
            options: {
              main:        'apps/api/src/main.ts',
              tsConfig:    'apps/api/tsconfig.json',
              // Resolved by Nx at run time; testing it literally would report a
              // file that is never meant to exist under this name.
              packageJson: '{projectRoot}/package.json',
            },
          },
        },
      }),
    )

    expect(collectFindings(workspaceRoot).filter(f => f.check.includes('apps/api'))).toEqual([])
  })

  it('reports a failing nx sync:check', () => {
    seedHealthyWorkspace()
    mockRunShell.mockImplementation(() => 1)

    expect(findingFor(collectFindings(workspaceRoot), 'project references synced')?.ok).toBe(false)
  })
})

describe('the rollup source-map check', () => {
  it('passes a config @stylistic/key-spacing (aligned on value) has reformatted', () => {
    // The reported bug, reproduced exactly: an object whose longest key is
    // additionalEntryPoints gets every value column-aligned, so
    // `sourceMap: true,` becomes `sourceMap:             true,`. Source maps
    // are still genuinely on; only the check used to be a literal string
    // match that could not see it.
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'packages/sdk'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'packages/sdk/rollup.config.cjs'),
      [
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
        '    sourceMap:             true',
        '  },',
        '  {',
        '    // Provide additional rollup configuration here. See: https://rollupjs.org/configuration-options',
        '  }',
        ');',
      ].join('\n'),
    )

    const finding = findingFor(collectFindings(workspaceRoot), 'source maps enabled')

    expect(finding?.ok).toBe(true)
  })

  it('passes a config that delegates via require() to a shared base with source maps on', () => {
    // The other shape from the report: a workspace that hoists withNx() into
    // one root rollup.base.cjs and leaves each project as a one-line
    // delegation. A text-only check of the project's own file finds nothing,
    // because the flag lives one file away.
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'packages/sdk'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'rollup.base.cjs'),
      [
        "const { withNx } = require('@nx/rollup/with-nx');",
        '',
        'module.exports = () => withNx(',
        '  {',
        "    compiler: 'babel',",
        '    sourceMap: true',
        '  },',
        '  {}',
        ');',
      ].join('\n'),
    )
    writeFileSync(
      join(workspaceRoot, 'packages/sdk/rollup.config.cjs'),
      "module.exports = require('../../rollup.base.cjs')()\n",
    )

    const finding = findingFor(collectFindings(workspaceRoot), 'source maps enabled')

    expect(finding?.ok).toBe(true)
  })

  it('fails a delegating config genuinely missing the flag, without recommending `mnci upgrade`', () => {
    // mnci upgrade edits the `},` / `{` boundary between withNx's two
    // arguments, which a one-line require() delegation does not have — it
    // cannot repair this shape, so the remedy must not send the user to a
    // command that silently no-ops and leaves the same failure behind.
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'packages/sdk'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'rollup.base.cjs'),
      "module.exports = () => ({ compiler: 'babel' })\n",
    )
    writeFileSync(
      join(workspaceRoot, 'packages/sdk/rollup.config.cjs'),
      "module.exports = require('../../rollup.base.cjs')()\n",
    )

    const finding = findingFor(collectFindings(workspaceRoot), 'source maps enabled')

    expect(finding?.ok).toBe(false)
    // Not the "run mnci upgrade" remedy — that command cannot touch this shape.
    expect(finding?.remedy).not.toContain('run `mnci upgrade`')
    expect(finding?.remedy).toContain('require()')
  })

  it('fails a genuinely un-fixed config and recommends `mnci upgrade`, which can actually repair it', () => {
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'packages/sdk'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'packages/sdk/rollup.config.cjs'),
      [
        "const { withNx } = require('@nx/rollup/with-nx');",
        '',
        'module.exports = withNx(',
        '  {',
        "    compiler: 'swc',",
        '  },',
        '  {',
        '    // Provide additional rollup configuration here. See: https://rollupjs.org/configuration-options',
        '  }',
        ');',
      ].join('\n'),
    )

    const finding = findingFor(collectFindings(workspaceRoot), 'source maps enabled')

    expect(finding?.ok).toBe(false)
    expect(finding?.remedy).toContain('mnci upgrade')
  })
})

/** The rollup config `@nx/js:lib --bundler=rollup` writes, before any repair. */
const GENERATED_ROLLUP_CONFIG = [
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
].join('\n')

describe('the declaration-specifier check', () => {
  it('passes a project carrying the current, directory-aware plugin', () => {
    // Built by the real generator rather than hand-written, so this cannot
    // drift from what `mnci add npm-lib` actually produces.
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'packages/sdk'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'packages/sdk/rollup.config.cjs'), GENERATED_ROLLUP_CONFIG)
    repairDeclarationSpecifiers(join(workspaceRoot, 'packages/sdk'))

    const findings = collectFindings(workspaceRoot)

    expect(findingFor(findings, 'normalises declaration specifiers')?.ok).not.toBe(false)
    expect(findingFor(findings, 'resolves directory barrels')?.ok).toBe(true)
  })

  it('catches the stale plugin that appends .js to a directory barrel', () => {
    // The dangerous state, and the reason this check exists: the plugin IS
    // there, the build succeeds, the package publishes, and every export
    // behind a directory barrel is `any` for every consumer. Nothing fails.
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'packages/sdk'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'packages/sdk/rollup.config.cjs'),
      [
        "const { withNx } = require('@nx/rollup/with-nx')",
        'module.exports = withNx(',
        '  {},',
        '  {',
        '    plugins: [',
        '      {',
        "        name: 'mnci-normalise-declaration-specifiers',",
        '        writeBundle(outputOptions) {',
        String.raw`          const bareRelativeSpecifier = /from(\s+)(['"])(\.[^'"]+?)\2/g;`,
        '          // appends .js unconditionally — no directory-barrel resolution',
        '        }',
        '      }',
        '    ]',
        '  }',
        ')',
      ].join('\n'),
    )

    const finding = findingFor(collectFindings(workspaceRoot), 'resolves directory barrels')

    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('/index.js')
    expect(finding?.remedy).toContain('mnci upgrade')
  })

  it('catches a rollup project with no declaration-specifier plugin at all', () => {
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'packages/sdk'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'packages/sdk/rollup.config.cjs'), GENERATED_ROLLUP_CONFIG)

    const finding = findingFor(collectFindings(workspaceRoot), 'normalises declaration specifiers')

    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('nodenext')
    // The remedy must NOT be a bare "run mnci upgrade": that command only
    // rewrites a plugin that is already present, so on this shape it no-ops
    // and the same finding comes back forever. Verified against the real
    // command. Asserted because the wrong remedy is easy to reintroduce and
    // impossible to notice from the code alone.
    expect(finding?.remedy).toContain('by hand')
    expect(finding?.remedy).toContain('cannot restore a missing one')
  })

  it('does recommend mnci upgrade for the stale plugin, because there it genuinely repairs', () => {
    // The other half of the same contract: upgrade IS the right answer when
    // there is a plugin body to replace, so this pins that the two findings
    // do not get collapsed into one generic message.
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'packages/sdk'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'packages/sdk/rollup.config.cjs'), GENERATED_ROLLUP_CONFIG)
    repairDeclarationSpecifiers(join(workspaceRoot, 'packages/sdk'))
    const configPath = join(workspaceRoot, 'packages/sdk/rollup.config.cjs')
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf8').replaceAll('resolveSpecifierSuffix', 'appendJs'),
    )

    const finding = findingFor(collectFindings(workspaceRoot), 'resolves directory barrels')
    expect(finding?.ok).toBe(false)
    expect(finding?.remedy).toContain('mnci upgrade')

    // And it is true: the sweep upgrade runs really does clear the finding.
    upgradeDeclarationSpecifierPlugins(workspaceRoot)
    expect(findingFor(collectFindings(workspaceRoot), 'resolves directory barrels')?.ok).toBe(true)
  })

  it('reads through a require() delegation to a shared base, like the source-map check', () => {
    // A workspace that hoists withNx() into one root base file leaves each
    // project a one-line delegation, so the plugin lives a file away — a
    // text-only check of the project's own file would report every project
    // broken when none of them are.
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'packages/sdk'), { recursive: true })
    // The base carries the real repaired plugin: generated into a scratch
    // project, then hoisted to the root as the shared base would be.
    const scratch = mkdtempSync(join(tmpdir(), 'mnci-base-'))
    writeFileSync(join(scratch, 'rollup.config.cjs'), GENERATED_ROLLUP_CONFIG)
    repairDeclarationSpecifiers(scratch)
    writeFileSync(
      join(workspaceRoot, 'rollup.base.cjs'),
      readFileSync(join(scratch, 'rollup.config.cjs'), 'utf8'),
    )
    rmSync(scratch, { recursive: true, force: true })
    writeFileSync(
      join(workspaceRoot, 'packages/sdk/rollup.config.cjs'),
      "module.exports = require('../../rollup.base.cjs')\n",
    )

    expect(findingFor(collectFindings(workspaceRoot), 'resolves directory barrels')?.ok).toBe(true)
  })
})

describe('the retired-formatter check', () => {
  it('passes on a workspace that has only ESLint', () => {
    writeWorkspace()

    const finding = collectFindings(workspaceRoot).find(f =>
      f.check.includes('only linter and formatter'),
    )

    expect(finding?.ok).toBe(true)
  })

  it('catches a config file left behind by a formatter mnci no longer runs', () => {
    // Inert from the command line — nothing invokes Prettier or oxfmt any more —
    // which is exactly why it needs reporting: a globally installed extension
    // still resolves it and reformats on save, quietly undoing Standard while
    // `npm run lint` stays green because the damage lands after the check.
    writeWorkspace()
    writeFileSync(join(workspaceRoot, '.prettierrc.mjs'), 'export default {}\n')

    const finding = collectFindings(workspaceRoot).find(f => f.check.includes('retired formatter'))

    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('.prettierrc.mjs')
    expect(finding?.remedy).toContain('mnci upgrade')
  })

  it('catches a retired tool that is only DECLARED, with no config file present', () => {
    // The other route to the same failure: the VS Code extension resolves a
    // formatter from the project's dependencies, so a declaration alone is
    // enough for it to find a real binary and run it.
    writeWorkspace({ prettier: '^3.8.1' })

    const finding = collectFindings(workspaceRoot).find(f => f.check.includes('retired formatter'))

    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('prettier')
  })
})

describe('runDoctor', () => {
  it('exits zero on a healthy workspace', () => {
    seedHealthyWorkspace()

    runDoctor(workspaceRoot)

    expect(process.exitCode).toBeUndefined()
  })

  it('exits non-zero when anything failed, so it works as a CI step', () => {
    seedHealthyWorkspace()
    writeFileSync(join(workspaceRoot, '.prettierrc'), '{}')

    runDoctor(workspaceRoot)

    expect(process.exitCode).toBe(1)
  })

  it('never edits the workspace — it only reports', () => {
    seedHealthyWorkspace()
    writeFileSync(join(workspaceRoot, '.prettierrc'), '{"singleQuote":true}')

    runDoctor(workspaceRoot)

    // The stray file is still there: doctor names the fix, it does not apply it.
    expect(() => collectFindings(workspaceRoot)).not.toThrow()
    expect(findingFor(collectFindings(workspaceRoot), 'retired formatter')?.ok).toBe(false)
  })
})
