import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { githubActionsYaml } from './overlay'

/**
 * Real bash + real node execution of the generated release step's RELEASE_SPECIFIER
 * handling — not review by eye. Extracts the exact `run:` command
 * {@link githubActionsYaml} emits, then executes it through `bash -c`, the same
 * shell GitHub Actions itself invokes a `run:` step through, so the full round
 * trip (YAML, then shell, then node — and its backslash escaping) is exercised
 * for real.
 */

function extractReleaseCommand (): string {
  const yaml = githubActionsYaml('ubuntu-latest', undefined, 'npm', 'github')
  const line = yaml.split('\n').find(candidate => candidate.trimStart().startsWith('- run: node -e ') && candidate.includes('releaseCmd'))
  if (!line) {
    throw new Error('release step not found in generated workflow')
  }

  return line.replace(/^\s*- run: /, '')
}

function runIn (dir: string, packageCount: number, specifier?: string): { status: number; stdout: string; stderr: string } {
  for (let i = 0; i < packageCount; i++) {
    const pkgDir = join(dir, 'packages', `pkg-${i}`)
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), '{}')
  }
  // A fake `npx` on PATH that just echoes what it was invoked with, instead of
  // actually running nx (which the generated command shells out to).
  const fakeBin = join(dir, 'fakebin')
  mkdirSync(fakeBin, { recursive: true })
  writeFileSync(
    join(fakeBin, 'npx'),
    '#!/bin/sh\necho "NPX_CALLED_WITH: $@"\nexit 0\n',
    { mode: 0o755 },
  )

  const command = extractReleaseCommand()
  try {
    const stdout = execSync(`bash -c ${JSON.stringify(command)}`, {
      cwd: dir,
      env: {
        ...process.env,
        PATH:              `${fakeBin}:${process.env.PATH}`,
        RELEASE_SPECIFIER: specifier ?? '',
      },
      encoding: 'utf8',
    })

    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const execError = error as { status: number; stdout: string; stderr: string }

    return { status: execError.status, stdout: execError.stdout, stderr: execError.stderr }
  }
}

describe('RELEASE_SPECIFIER survives the real YAML -> bash -> node round trip', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mnci-release-specifier-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes an exact version through verbatim, for a multi-package workspace', () => {
    const result = runIn(dir, 3, '1.2.3')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('NPX_CALLED_WITH: nx release 1.2.3 --yes')
  })

  it('passes a bare keyword through for a SINGLE-package workspace', () => {
    const result = runIn(dir, 1, 'minor')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('NPX_CALLED_WITH: nx release minor --yes')
  })

  it('fails fast on a bare keyword when more than one package is releasable', () => {
    const result = runIn(dir, 3, 'minor')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("RELEASE_SPECIFIER is a keyword ('minor')")
    expect(result.stderr).toContain('3 releasable packages')
  })

  it('fails fast on a garbage value', () => {
    const result = runIn(dir, 1, 'not-a-real-specifier')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("RELEASE_SPECIFIER value 'not-a-real-specifier' is invalid")
  })

  it('runs the plain release command when RELEASE_SPECIFIER is unset', () => {
    const result = runIn(dir, 3, undefined)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('NPX_CALLED_WITH: nx release --yes')
  })

  it('accepts a pre-release exact version', () => {
    const result = runIn(dir, 3, '2.0.0-beta.1')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('NPX_CALLED_WITH: nx release 2.0.0-beta.1 --yes')
  })
})
