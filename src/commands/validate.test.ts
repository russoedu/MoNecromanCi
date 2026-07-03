import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../engine/config'
import type { MonecromanciConfig } from '../engine/types'

jest.mock('../util/exec', () => ({ runShell: jest.fn() }))

import { runShell } from '../util/exec'
import { runValidate } from './validate'

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
let originalExitCode: typeof process.exitCode

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'monecromanci-validate-'))
  jest.spyOn(process, 'cwd').mockReturnValue(repoRoot)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  originalExitCode = process.exitCode
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
  mockRunShell.mockReset()
  process.exitCode = originalExitCode
})

describe('runValidate', () => {
  it('errors when the directory is not a MoNecromanCI repo', async () => {
    await runValidate({ all: false })
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No .monecromanci.json found'))
    expect(mockRunShell).not.toHaveBeenCalled()
  })

  it('runs nx affected for the lint/test/build targets by default', async () => {
    saveConfig(repoRoot, config)
    mockRunShell.mockReturnValue(0)
    await runValidate({ all: false })
    expect(mockRunShell).toHaveBeenCalledWith('npx', ['nx', 'affected', '-t', 'lint', 'test', 'build'], repoRoot)
    expect(existsSync(join(repoRoot, 'MoNecromanCi.md'))).toBe(true)
  })

  it('runs nx run-many when --all is set', async () => {
    saveConfig(repoRoot, config)
    mockRunShell.mockReturnValue(0)
    await runValidate({ all: true })
    expect(mockRunShell).toHaveBeenCalledWith('npx', ['nx', 'run-many', '-t', 'lint', 'test', 'build'], repoRoot)
  })

  it('propagates a non-zero child status to process.exitCode', async () => {
    saveConfig(repoRoot, config)
    mockRunShell.mockReturnValue(2)
    await runValidate({ all: false })
    expect(process.exitCode).toBe(2)
  })

  it('leaves the exit code untouched on success', async () => {
    saveConfig(repoRoot, config)
    mockRunShell.mockReturnValue(0)
    await runValidate({ all: false })
    expect(process.exitCode).toBe(originalExitCode)
  })
})
