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

/**
 * How many releasable projects of each shape to seed, mirroring exactly what
 * each generator writes: npm gets `package.json`, Dart gets `pubspec.yaml`
 * (and pointedly NO `package.json`), C# a `.csproj`, Python a
 * `pyproject.toml` under its own `python-packages/` root.
 */
interface Workspace {
  npm?:    number
  dart?:   number
  csharp?: number
  python?: number
}

function seed (dir: string, workspace: Workspace): void {
  const write = (root: string, prefix: string, count: number, file: string): void => {
    for (let index = 0; index < count; index++) {
      const projectRoot = join(dir, root, `${prefix}-${index}`)
      mkdirSync(projectRoot, { recursive: true })
      writeFileSync(join(projectRoot, file), '')
    }
  }
  write('packages', 'npm', workspace.npm ?? 0, 'package.json')
  write('packages', 'dart', workspace.dart ?? 0, 'pubspec.yaml')
  write('packages', 'csharp', workspace.csharp ?? 0, 'app.csproj')
  write('python-packages', 'py', workspace.python ?? 0, 'pyproject.toml')
}

function runIn (
  dir: string,
  workspace: number | Workspace,
  specifier?: string,
): { status: number; stdout: string; stderr: string } {
  seed(dir, typeof workspace === 'number' ? { npm: workspace } : workspace)
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

describe('every releasable manifest shape is detected, not just npm', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mnci-release-shapes-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('releases a Flutter-only workspace instead of skipping it', () => {
    // The bug this exists for. A publishable flutter-lib lands in packages/
    // with a pubspec.yaml and NO package.json, so while the guard counted
    // only npm/C#/Python manifests it logged "Nothing to release" and exited
    // 0 — on every release run, forever, green. Dart is also the one kind
    // with no publish step (publishing IS the tag), so nothing downstream
    // could ever have surfaced it.
    const result = runIn(dir, { dart: 1 })

    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('Nothing to release')
    expect(result.stdout).toContain('NPX_CALLED_WITH: nx release --yes')
  })

  it('counts a Dart package toward the keyword guard, so npm+dart is 2 and not 1', () => {
    // The second-order defect of the same miss: under-counting did not just
    // skip releases, it weakened the keyword check. One npm lib plus one
    // flutter lib counted as 1, so a bare keyword — the input that silently
    // under-bumps interdependent packages — was accepted for a workspace
    // that has exactly the shape it is unsafe for.
    const result = runIn(dir, { npm: 1, dart: 1 }, 'minor')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('2 releasable packages')
  })

  it('still skips cleanly when there is genuinely nothing to release', () => {
    // The other direction: widening detection must not break the empty-scope
    // skip, which exists because nx release hard-errors on an empty scope.
    const result = runIn(dir, {})

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Nothing to release - skipping.')
  })

  it('counts C# and Python alongside the rest', () => {
    const result = runIn(dir, { npm: 1, dart: 1, csharp: 1, python: 1 }, 'major')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('4 releasable packages')
  })
})
