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
function seedHealthyWorkspace (): void {
  writeFileSync(
    join(workspaceRoot, 'nx.json'),
    JSON.stringify({
      plugins: [{ plugin: '@nx/eslint/plugin', options: { targetName: 'lint' } }],
      mnci: { registry: { kind: 'npm' }, scope: '@demo' }
    })
  )
  writeFileSync(join(workspaceRoot, 'eslint.config.mjs'), 'export default []')
  // No formatter config: ESLint is the formatter, and every Prettier/oxfmt file
  // is now something `checkNoRetiredFormatter` reports.
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ devDependencies: {} }))
  writeFileSync(
    join(workspaceRoot, '.npmrc'),
    '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n'
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

describe('the retired-formatter check', () => {
  it('passes on a workspace that has only ESLint', () => {
    writeWorkspace()

    const finding = collectFindings(workspaceRoot).find(f =>
      f.check.includes('only linter and formatter')
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
