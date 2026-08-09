// nx sync:check is the one check that shells out. Mocked so the suite neither
// needs a real Nx graph nor pays for a subprocess per test; the sync finding is
// asserted through the mock's return code instead.
jest.mock('../nx', () => ({ runShell: jest.fn(() => 0) }))

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runShell } from '../nx'
import { collectFindings, runDoctor, type Finding } from './doctor'

const mockRunShell = jest.mocked(runShell)

let workspaceRoot: string

/** A workspace where every invariant holds, for tests to break one at a time. */
function seedHealthyWorkspace(): void {
  writeFileSync(
    join(workspaceRoot, 'nx.json'),
    JSON.stringify({
      plugins: [{ plugin: '@nx/eslint/plugin', options: { targetName: 'lint' } }],
      mnci: { registry: { kind: 'npm' }, scope: '@demo' }
    })
  )
  writeFileSync(join(workspaceRoot, 'eslint.config.mjs'), 'export default []')
  writeFileSync(join(workspaceRoot, '.prettierrc.json'), '{}')
  writeFileSync(
    join(workspaceRoot, '.npmrc'),
    '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n'
  )
}

/**
 * Seeds a healthy workspace for one linter choice.
 *
 * @param linter - The linter to persist in `nx.json`'s `mnci` block.
 * @param devDependencies - The manifest's declared devDependencies.
 */
function seedFor(linter: 'eslint' | 'oxlint', devDependencies: Record<string, string>): void {
  seedHealthyWorkspace()
  // Clear both modes first, so calling this twice in one test does not leave the
  // previous mode's config behind and assert against a workspace no `mnci
  // upgrade` would ever produce.
  for (const file of ['oxlint.config.ts', '.oxfmtrc.json', '.prettierrc.mjs']) {
    rmSync(join(workspaceRoot, file), { force: true })
  }
  writeFileSync(
    join(workspaceRoot, 'nx.json'),
    JSON.stringify({
      plugins: [{ plugin: '@nx/eslint/plugin', options: { targetName: 'lint' } }],
      mnci: { registry: { kind: 'npm' }, scope: '@demo', stack: { testRunner: 'jest', linter } }
    })
  )
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ devDependencies }))
  if (linter === 'oxlint') {
    writeFileSync(join(workspaceRoot, 'oxlint.config.ts'), 'export default {}')
    writeFileSync(join(workspaceRoot, '.oxfmtrc.json'), '{}')
  } else {
    writeFileSync(join(workspaceRoot, '.prettierrc.mjs'), 'export default {}')
  }
}

const oxlintToolchain = { oxlint: '^1', oxfmt: '^0.61', '@mnci/oxlint-config': '^0.1' }

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

  it('catches a stray .prettierrc, which silently outranks .prettierrc.json', () => {
    seedHealthyWorkspace()
    writeFileSync(join(workspaceRoot, '.prettierrc'), '{"singleQuote":true}')

    const finding = findingFor(collectFindings(workspaceRoot), 'Prettier config')

    // Invisible without a check: both files exist and both look fine.
    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('outranks')
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
      JSON.stringify({ plugins: ['@nx/eslint/plugin'] })
    )

    expect(findingFor(collectFindings(workspaceRoot), '@nx/eslint/plugin')?.ok).toBe(true)
  })

  it('catches a resolved eslint major outside the supported one — the drift that shipped', () => {
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'node_modules/eslint'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'node_modules/eslint/package.json'),
      JSON.stringify({ name: 'eslint', version: '9.39.5' })
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
      JSON.stringify({ name: 'eslint', version: '10.8.0' })
    )

    expect(findingFor(collectFindings(workspaceRoot), 'resolved eslint')?.ok).toBe(true)
  })

  it('skips the eslint check entirely when nothing is installed', () => {
    seedHealthyWorkspace()

    // "not installed yet" is not drift, and reporting it as a failure would train
    // people to ignore the output.
    expect(findingFor(collectFindings(workspaceRoot), 'resolved eslint')).toBeUndefined()
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
        mnci: {
          scope: '@demo',
          registry: {
            kind: 'azure-artifacts',
            organization: 'org',
            project: 'proj',
            artifactsFeed: 'feed'
          }
        }
      })
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
        release: { version: { versionActions: '@mnci/nx-flutter/release/version-actions' } }
      })
    )

    expect(findingFor(collectFindings(workspaceRoot), 'packages/shared')?.ok).toBe(true)
  })

  it('catches a build target whose main names a file that was never written', () => {
    seedHealthyWorkspace()
    mkdirSync(join(workspaceRoot, 'apps/api/src'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'apps/api/project.json'),
      JSON.stringify({
        targets: { build: { options: { main: 'apps/api/src/index.ts' } } }
      })
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
      JSON.stringify({ targets: { build: { options: { main: 'apps/api/src/index.ts' } } } })
    )
    writeFileSync(
      join(workspaceRoot, 'apps/api/package.json'),
      JSON.stringify({
        name: '@demo/api',
        nx: { targets: { build: { options: { main: 'apps/api/src/main.ts' } } } }
      })
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
            options: { main: 'libs/models/src/index.ts', tsConfig: 'libs/models/tsconfig.lib.json' }
          }
        }
      })
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
              main: 'apps/api/src/main.ts',
              tsConfig: 'apps/api/tsconfig.json',
              // Resolved by Nx at run time; testing it literally would report a
              // file that is never meant to exist under this name.
              packageJson: '{projectRoot}/package.json'
            }
          }
        }
      })
    )

    expect(collectFindings(workspaceRoot).filter(f => f.check.includes('apps/api'))).toEqual([])
  })

  it('reports a failing nx sync:check', () => {
    seedHealthyWorkspace()
    mockRunShell.mockImplementation(() => 1)

    expect(findingFor(collectFindings(workspaceRoot), 'project references synced')?.ok).toBe(false)
  })
})

describe('the linter-mode checks', () => {
  it('passes on a healthy workspace of either mode', () => {
    for (const [linter, devDeps] of [
      ['eslint', { prettier: '^3' }],
      ['oxlint', oxlintToolchain]
    ] as const) {
      seedFor(linter, devDeps)
      expect(collectFindings(workspaceRoot).filter(finding => !finding.ok)).toEqual([])
    }
  })

  it('catches a formatter config left over from the mode the workspace left', () => {
    // The shape that makes this worth a check: each file is valid on its own, so
    // nothing errors. The CLI reads one, the editor extension may read the other,
    // and a file formatted by `npm run format` gets reformatted on save.
    seedFor('oxlint', oxlintToolchain)
    writeFileSync(join(workspaceRoot, '.prettierrc.mjs'), 'export default {}')

    expect(findingFor(collectFindings(workspaceRoot), 'config files are present')?.ok).toBe(false)
  })

  it('catches an oxlint config in a workspace whose persisted linter is eslint', () => {
    seedFor('eslint', { prettier: '^3' })
    writeFileSync(join(workspaceRoot, 'oxlint.config.ts'), 'export default {}')

    expect(findingFor(collectFindings(workspaceRoot), 'config files are present')?.ok).toBe(false)
  })

  it('catches prettier still declared in an oxlint workspace', () => {
    // Not cosmetic: prettier-vscode resolves the formatter from the PROJECT's
    // dependencies, so the declaration is what lets a globally installed prettier
    // extension format on save against the opinion oxfmt is not applying — while
    // `npm run format:check` (oxfmt) reports the result as unformatted.
    seedFor('oxlint', { ...oxlintToolchain, prettier: '^3' })

    expect(findingFor(collectFindings(workspaceRoot), 'is declared as the formatter')?.ok).toBe(
      false
    )
  })

  it('catches oxfmt still declared in an eslint workspace, so the check is symmetric', () => {
    seedFor('eslint', { prettier: '^3', oxfmt: '^0.61' })

    expect(findingFor(collectFindings(workspaceRoot), 'is declared as the formatter')?.ok).toBe(
      false
    )
  })

  it('catches an oxlint workspace missing a binary it peers on', () => {
    // `@mnci/oxlint-config` peers on `oxlint`, so nothing installs it for you.
    // Missing it turns `npm run lint` into "command not found" at the worst moment
    // instead of at install time.
    seedFor('oxlint', { oxfmt: '^0.61', '@mnci/oxlint-config': '^0.1' })
    const finding = findingFor(collectFindings(workspaceRoot), 'oxlint toolchain declared')

    expect(finding?.ok).toBe(false)
    expect(finding?.detail).toContain('oxlint')
  })

  it('reports the oxlint toolchain check as ok on an eslint workspace, never omits it', () => {
    // A check that silently disappears is one nobody notices has stopped running,
    // so it reports `ok` with a reason rather than being filtered out.
    seedFor('eslint', { prettier: '^3' })
    const finding = findingFor(collectFindings(workspaceRoot), 'oxlint toolchain declared')

    expect(finding?.ok).toBe(true)
    expect(finding?.detail).toBe('not an oxlint workspace')
  })

  it('defaults to eslint when no linter is persisted, so an old workspace is not flagged', () => {
    // Every workspace generated before the choice existed has no `stack.linter`.
    // Treating that as "no mode chosen" would fail both checks on all of them.
    seedHealthyWorkspace()
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({}))

    expect(collectFindings(workspaceRoot).filter(finding => !finding.ok)).toEqual([])
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
    expect(findingFor(collectFindings(workspaceRoot), 'Prettier config')?.ok).toBe(false)
  })
})
