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

  it('reports a failing nx sync:check', () => {
    seedHealthyWorkspace()
    mockRunShell.mockImplementation(() => 1)

    expect(findingFor(collectFindings(workspaceRoot), 'project references synced')?.ok).toBe(false)
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
