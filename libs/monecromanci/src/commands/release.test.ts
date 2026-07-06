import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../engine/config'
import type { MonecromanciConfig } from '../engine/types'

jest.mock('../util/exec', () => ({ runShell: jest.fn() }))

import { runShell } from '../util/exec'
import { runRelease } from './release'

const mockRunShell = jest.mocked(runShell)

const config: MonecromanciConfig = {
  templateVersion: '0.2.0',
  workspaceName:   'demo',
  displayName:     'Demo',
  scope:           '@demo',
  defaultBase:     'main',
  nodeVersion:     '24',
  ci:              'github',
  registry:        { kind: 'npm' },
}

let repoRoot: string
let errorSpy: jest.SpyInstance
let warnSpy: jest.SpyInstance
let originalExitCode: typeof process.exitCode

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'monecromanci-release-'))
  jest.spyOn(process, 'cwd').mockReturnValue(repoRoot)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  originalExitCode = process.exitCode
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
  mockRunShell.mockReset()
  process.exitCode = originalExitCode
})

describe('runRelease', () => {
  it('errors when the directory is not a MoNecromanCI repo', async () => {
    await runRelease()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No .monecromanci.json found'))
    expect(mockRunShell).not.toHaveBeenCalled()
  })

  it('fetches tags before previewing the release, and writes the guide', async () => {
    saveConfig(repoRoot, config)
    mockRunShell.mockReturnValue(0)

    await runRelease()

    expect(mockRunShell).toHaveBeenNthCalledWith(1, 'git', ['fetch', '--all', '--prune', '--tags'], repoRoot)
    expect(mockRunShell).toHaveBeenNthCalledWith(2, 'npx', ['nx', 'release', 'version', '--dry-run'], repoRoot)
    expect(existsSync(join(repoRoot, 'MoNecromanCi.md'))).toBe(true)
  })

  it('warns but still previews when fetching tags fails', async () => {
    saveConfig(repoRoot, config)
    mockRunShell.mockReturnValueOnce(1).mockReturnValueOnce(0)

    await runRelease()

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not fetch tags'))
    expect(mockRunShell).toHaveBeenNthCalledWith(2, 'npx', ['nx', 'release', 'version', '--dry-run'], repoRoot)
    expect(process.exitCode).toBe(originalExitCode)
  })

  it('propagates a non-zero dry-run status to process.exitCode', async () => {
    saveConfig(repoRoot, config)
    mockRunShell.mockReturnValueOnce(0).mockReturnValueOnce(3)

    await runRelease()

    expect(process.exitCode).toBe(3)
  })

  it('leaves the exit code untouched on success', async () => {
    saveConfig(repoRoot, config)
    mockRunShell.mockReturnValue(0)

    await runRelease()

    expect(process.exitCode).toBe(originalExitCode)
  })
})
