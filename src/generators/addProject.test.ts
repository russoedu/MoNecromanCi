import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configFromVars, saveConfig } from '../engine/config'
import { readJsonSafe } from '../engine/fsx'
import type { MonorepoVars } from '../engine/types'
import { runAdd } from './addProject'

jest.mock('../util/prompts', () => ({
  promptText: jest.fn(),
  select:     jest.fn(),
}))

import { promptText, select } from '../util/prompts'

const mockPromptText = jest.mocked(promptText)
const mockSelect = jest.mocked(select)

const vars: MonorepoVars = {
  workspaceName: 'demo',
  displayName:   'Demo',
  scope:         '@demo',
  defaultBase:   'main',
  nodeVersion:   '24',
  ci:            'azure',
  registry:      { kind: 'azure-artifacts', organization: 'org', project: 'proj', artifactsFeed: 'feed' },
}

let repoRoot: string
let logSpy: jest.SpyInstance
let errorSpy: jest.SpyInstance

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'monecromanci-addproject-'))
  jest.spyOn(process, 'cwd').mockReturnValue(repoRoot)
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

function readManifest (): Record<string, unknown> {
  return readJsonSafe<Record<string, unknown>>(join(repoRoot, 'package.json'), {})
}

describe('runAdd', () => {
  it('errors when the directory is not a MoNecromanCI repo', async () => {
    await runAdd({ type: 'internal-lib', name: 'foo' })
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No .monecromanci.json found'))
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('errors when the stamp exists but cannot be parsed', async () => {
    saveConfig(repoRoot, configFromVars(vars))
    jest.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new Error('bad json')
    })
    await runAdd({ type: 'internal-lib', name: 'foo' })
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Could not read .monecromanci.json'))
  })

  it('uses the provided type and name without prompting', async () => {
    saveConfig(repoRoot, configFromVars(vars))
    await runAdd({ type: 'internal-lib', name: 'Helper Lib' })
    expect(mockSelect).not.toHaveBeenCalled()
    expect(mockPromptText).not.toHaveBeenCalled()
    expect(readManifest()).toEqual({})
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Done. Run `npm install`'))
  })

  it('prompts for the kind when no type is provided', async () => {
    saveConfig(repoRoot, configFromVars(vars))
    mockSelect.mockResolvedValue('function-app')
    await runAdd({ name: 'api' })
    expect(mockSelect).toHaveBeenCalledWith(expect.objectContaining({ message: 'What do you want to add?' }))
    expect(readManifest().dependencies).toEqual({ '@azure/functions': '^4.16.0' })
  })

  it('prompts for the name and slugifies it when no name is provided', async () => {
    saveConfig(repoRoot, configFromVars(vars))
    mockPromptText.mockResolvedValue('My New Lib')
    await runAdd({ type: 'internal-lib' })
    expect(mockPromptText).toHaveBeenCalledWith('Project name')
  })
})
