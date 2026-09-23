import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { githubActionsYaml } from './workspace-overlay'

/**
 * Real bash + real node execution of the generated npm auth preflight, with a
 * stub `npm` on PATH — not review by eye.
 *
 * @remarks
 * The guard exists because `nx release` tags BEFORE it publishes, so a rejected
 * token leaves a version tagged with nothing on the registry, and the next run
 * resolves the current version from that tag — skipping the number forever. A
 * real workspace lost `0.0.2` that way.
 *
 * Which means a guard that silently passes is the one failure this must not
 * have, so every branch is executed rather than asserted on the emitted string.
 */

/** The exact `run:` command the generated workflow emits for the preflight. */
function extractPreflight (): string {
  const yaml = githubActionsYaml('ubuntu-latest', undefined, 'npm', 'github')
  const line = yaml
    .split('\n')
    .find(candidate => candidate.trimStart().startsWith('- run: node -e ') && candidate.includes('whoami'))
  if (!line) {
    throw new Error('preflight step not found in the generated workflow')
  }

  return line.replace(/^\s*- run: /, '')
}

/**
 * Runs the guard in a throwaway workspace.
 *
 * @param options - `packages` seeds that many npm packages; `token` is the
 * NODE_AUTH_TOKEN value; `whoami` is the stub npm's exit status and output.
 * @returns The exit status and combined output.
 */
function runGuard (options: {
  packages?: number
  token?:    string
  whoami?:   { status: number, says: string }
}): { status: number, stdout: string, stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mnci-npm-preflight-'))
  try {
    for (let index = 0; index < (options.packages ?? 1); index++) {
      mkdirSync(join(dir, 'packages', `p-${index}`), { recursive: true })
      writeFileSync(join(dir, 'packages', `p-${index}`, 'package.json'), '{}')
    }
    const fakeBin = join(dir, 'fakebin')
    mkdirSync(fakeBin, { recursive: true })
    const { status = 0, says = 'someone' } = options.whoami ?? {}
    writeFileSync(join(fakeBin, 'npm'), `#!/bin/sh\necho "${says}"\nexit ${status}\n`, { mode: 0o755 })
    /*
     * A `.cmd` twin: the guard spawns npm with `shell: true` on Windows, and
     * cmd.exe cannot execute an extensionless shell script however executable
     * its mode bit claims to be.
     */
    writeFileSync(join(fakeBin, 'npm.cmd'), `@echo off\r\necho ${says}\r\nexit /b ${status}\r\n`)

    try {
      const stdout = execFileSync('bash', ['-c', extractPreflight()], {
        cwd:      dir,
        encoding: 'utf8',
        env:      {
          ...process.env,
          // `path.delimiter`, not ':' — on Windows the separator is ';' and
          // every entry carries a drive colon, so a ':' join is unusable.
          PATH:            `${fakeBin}${delimiter}${process.env.PATH}`,
          NODE_AUTH_TOKEN: options.token ?? '',
        },
      })

      return { status: 0, stdout, stderr: '' }
    } catch (error) {
      const failure = error as { status: number, stdout: string, stderr: string }

      return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the npm auth preflight survives the real YAML -> bash -> node round trip', () => {
  it('passes, naming the user, when the registry accepts the token', () => {
    const result = runGuard({ token: 'a-real-token', whoami: { status: 0, says: 'russoedu' } })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('npm auth OK as russoedu')
  })

  it('fails fast when the secret is unset, before anything is tagged', () => {
    /*
     * Separate from the rejected-token branch on purpose: an unset secret
     * renders blank in the step's env log rather than as `***`, so naming the
     * case turns the most common setup mistake into one sentence.
     */
    const result = runGuard({ token: '' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('NPM_TOKEN is empty or unset')
    expect(result.stderr).toContain('Automation token')
  })

  it('fails when the token is present but the registry rejects it', () => {
    /*
     * The branch a variable-only check would miss entirely: an expired or
     * under-scoped token is set, looks fine, and fails at exactly the late
     * moment this guard exists to move earlier.
     */
    const result = runGuard({
      token:  'an-expired-token',
      whoami: { status: 1, says: 'ENEEDAUTH' },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('the registry rejected it')
    expect(result.stderr).toContain('ENEEDAUTH')
  })

  it('skips cleanly when the workspace has no npm packages', () => {
    // A Python- or C#-only workspace must not be blocked by an npm token it
    // has no use for.
    const result = runGuard({ packages: 0, token: '' })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('No npm packages to release - skipping.')
  })
})
