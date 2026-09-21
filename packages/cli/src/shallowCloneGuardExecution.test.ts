import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { githubActionsYaml } from './overlay'

/**
 * Real bash + real node + real git execution of the generated shallow-clone
 * guard — not review by eye. Extracts the exact `run:` command
 * {@link githubActionsYaml} emits, then executes it through `bash -c` against
 * real git repositories (one shallow, one full), the same way a CI `run:`
 * step actually runs it.
 */

function extractGuardCommand (): string {
  const yaml = githubActionsYaml('ubuntu-latest', undefined, 'npm', 'github')
  const line = yaml
    .split('\n')
    .find(candidate => candidate.trimStart().startsWith('- run: node -e ') &&
      candidate.includes('is-shallow-repository'))
  if (!line) {
    throw new Error('shallow-clone guard step not found in generated workflow')
  }

  return line.replace(/^\s*- run: /, '')
}

function run (dir: string): { status: number; stdout: string; stderr: string } {
  const command = extractGuardCommand()
  try {
    const stdout = execSync(`bash -c ${JSON.stringify(command)}`, {
      cwd:      dir,
      encoding: 'utf8',
    })

    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const execError = error as { status: number; stdout: string; stderr: string }

    return { status: execError.status, stdout: execError.stdout, stderr: execError.stderr }
  }
}

describe('the shallow-clone guard survives the real YAML -> bash -> node -> git round trip', () => {
  let dir: string

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes on a full clone', () => {
    dir = mktempFullRepo()

    const result = run(dir)

    expect(result.status).toBe(0)
  })

  it('fails fast on a shallow clone, naming the fix', () => {
    dir = mkdtempSync(join(tmpdir(), 'mnci-shallow-'))
    const source = mktempFullRepo()
    // A real shallow clone, the same shape a shallow actions/checkout or a
    // reduced fetchDepth would leave behind.
    execSync(`git clone --depth 1 file://${source} ${dir}`, { encoding: 'utf8' })

    const result = run(dir)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('shallow clone')
    expect(result.stderr).toContain('DOWNGRADE')
    expect(result.stderr).toContain('fetchDepth')
    expect(result.stderr).toContain('fetch-depth')
  })
})

/**
 * A real, throwaway, non-shallow git repository with two commits — enough
 * history that a subsequent shallow clone of it is genuinely shallow.
 */
function mktempFullRepo (): string {
  const dir = mkdtempSync(join(tmpdir(), 'mnci-full-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 'mnci-test', GIT_AUTHOR_EMAIL: 'mnci@example.com', GIT_COMMITTER_NAME: 'mnci-test', GIT_COMMITTER_EMAIL: 'mnci@example.com' }
  execSync('git init -q', { cwd: dir, env })
  execSync('git commit -q --allow-empty -m "first"', { cwd: dir, env })
  execSync('git commit -q --allow-empty -m "second"', { cwd: dir, env })

  return dir
}
