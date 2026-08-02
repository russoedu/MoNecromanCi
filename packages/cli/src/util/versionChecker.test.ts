jest.mock('cross-spawn', () => ({ __esModule: true, default: { sync: jest.fn() } }))

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import spawn from 'cross-spawn'
import { checkForUpdate, readCliVersion } from './versionChecker'

const mockSpawnSync = jest.mocked(spawn.sync)

/** A successful `npm view` result reporting `version`. */
function registryReturns(version: string): void {
  mockSpawnSync.mockReturnValue({ status: 0, stdout: `${version}\n` } as never)
}

/** Runs every pending `setImmediate` callback and returns what was logged. */
async function flushAndCapture(): Promise<string> {
  const lines: string[] = []
  const logSpy = jest.spyOn(console, 'log').mockImplementation(message => {
    lines.push(String(message))
  })
  await new Promise(resolve => setImmediate(resolve))
  logSpy.mockRestore()
  return lines.join('\n')
}

let isTTY: boolean | undefined

beforeEach(() => {
  // The check is TTY-gated, so tests must opt in to being "interactive".
  isTTY = process.stdout.isTTY
  process.stdout.isTTY = true
})

afterEach(() => {
  process.stdout.isTTY = isTTY as boolean
  jest.clearAllMocks()
  jest.restoreAllMocks()
})

describe('checkForUpdate', () => {
  it('returns immediately without touching the registry (the work is deferred)', async () => {
    registryReturns('9.9.9')

    expect(checkForUpdate('1.0.0')).toBeUndefined()
    // Deferred to setImmediate, so nothing has run yet on this tick — this is
    // what keeps the check off the critical path of the invoked command.
    expect(mockSpawnSync).not.toHaveBeenCalled()

    // Drain the callback this test queued, so it cannot fire inside a later
    // test's flush and report against that test's mock.
    await flushAndCapture()
  })

  it('does nothing at all when stdout is not a TTY', async () => {
    // CI and piped invocations: nobody reads the notice, and the registry
    // call is a blocking spawn — so they should not pay for it, nor risk a
    // notice landing in parsed output.
    process.stdout.isTTY = false
    registryReturns('2.0.0')

    checkForUpdate('1.0.0')

    expect(await flushAndCapture()).toBe('')
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })

  it('reports a newer published version', async () => {
    registryReturns('2.0.0')

    checkForUpdate('1.0.0')
    const output = await flushAndCapture()

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'npm',
      ['view', '@mnci/cli', 'version'],
      expect.objectContaining({ timeout: 2000 })
    )
    expect(output).toContain('2.0.0')
    expect(output).toContain('npm install -g @mnci/cli@latest')
  })

  it('stays silent when the running version is current or ahead', async () => {
    registryReturns('1.0.0')
    checkForUpdate('1.0.0')
    expect(await flushAndCapture()).toBe('')

    registryReturns('1.0.0')
    checkForUpdate('1.2.0')
    expect(await flushAndCapture()).toBe('')
  })

  it('compares numerically, not lexicographically', async () => {
    // The bug this guards: '10' < '9' as strings, so a lexicographic compare
    // would miss the upgrade from 1.9.0 to 1.10.0 entirely.
    registryReturns('1.10.0')

    checkForUpdate('1.9.0')

    expect(await flushAndCapture()).toContain('1.10.0')
  })

  it('stays silent when the registry call fails, times out or returns junk', async () => {
    for (const result of [
      { status: 1, stdout: '' },
      { error: new Error('ETIMEDOUT'), status: null, stdout: '' },
      { status: 0, stdout: ' '.repeat(3) },
      { status: 0, stdout: 'not-a-version' }
    ]) {
      mockSpawnSync.mockReturnValue(result as never)
      checkForUpdate('1.0.0')
      expect(await flushAndCapture()).toBe('')
    }
  })

  it('never throws, even when the registry call blows up outright', async () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error('spawn ENOENT')
    })

    expect(() => checkForUpdate('1.0.0')).not.toThrow()
    // The throw happens inside the deferred callback; flushing must not
    // surface it as an unhandled error either.
    await expect(flushAndCapture()).resolves.toBe('')
  })
})

describe('readCliVersion', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mnci-version-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('reads the version from the manifest one level up from the entry point', () => {
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '4.2.0' }))

    expect(readCliVersion(join(directory, 'dist'))).toBe('4.2.0')
  })

  it('falls back to 0.0.0 when the manifest is missing, unparseable or versionless', () => {
    expect(readCliVersion(join(directory, 'dist'))).toBe('0.0.0')

    writeFileSync(join(directory, 'package.json'), '{ not json')
    expect(readCliVersion(join(directory, 'dist'))).toBe('0.0.0')

    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'x' }))
    expect(readCliVersion(join(directory, 'dist'))).toBe('0.0.0')
  })
})
