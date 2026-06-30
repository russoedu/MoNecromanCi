import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isManagedRepo, loadConfig } from '../engine/config'
import { runNew } from './createMonorepo'

jest.mock('../util/prompts', () => ({
  confirm:    jest.fn(),
  promptText: jest.fn(),
  select:     jest.fn(),
}))

import { confirm, promptText, select } from '../util/prompts'

const mockConfirm = jest.mocked(confirm)
const mockPromptText = jest.mocked(promptText)
const mockSelect = jest.mocked(select)

let cwdDirectory: string
let logSpy: jest.SpyInstance
let warnSpy: jest.SpyInstance

beforeEach(() => {
  cwdDirectory = mkdtempSync(join(tmpdir(), 'monecromanci-new-'))
  jest.spyOn(process, 'cwd').mockReturnValue(cwdDirectory)
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  // CI provider + registry kind prompts: default to Azure DevOps / Azure Artifacts.
  mockSelect.mockImplementation((options) => {
    const { message } = options as { message: string }
    return Promise.resolve(message === 'CI provider' ? 'azure' : 'azure-artifacts') as never
  })
})

afterEach(() => {
  rmSync(cwdDirectory, { recursive: true, force: true })
  jest.restoreAllMocks()
})

describe('runNew', () => {
  it('uses provided options as-is in non-interactive mode and normalises a bare scope', async () => {
    const target = join(cwdDirectory, 'my-repo')
    await runNew({
      name:         'My Repo',
      scope:        'auto',
      organization: 'my-org',
      project:      'Automation',
      feed:         'AUTO',
      base:         'main',
      lib:          'helpers',
      yes:          true,
    })

    expect(mockPromptText).not.toHaveBeenCalled()
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(loadConfig(target)?.scope).toBe('@auto')
    expect(existsSync(join(target, 'libs/helpers/package.json'))).toBe(true)
  })

  it('falls back to defaults for every unset field in non-interactive mode', async () => {
    await runNew({ yes: true })

    const target = join(cwdDirectory, 'my-monorepo')
    expect(mockPromptText).not.toHaveBeenCalled()
    const config = loadConfig(target)
    expect(config?.displayName).toBe('My Monorepo')
    expect(config?.scope).toBe('@auto')
    expect(existsSync(join(target, 'libs/helpers/package.json'))).toBe(true)
  })

  it('skips the initial library when lib is explicitly the empty string', async () => {
    await runNew({ yes: true, lib: '' })

    const target = join(cwdDirectory, 'my-monorepo')
    expect(isManagedRepo(target)).toBe(true)
    expect(readdirSync(join(target, 'libs'))).toEqual(['.gitkeep'])
  })

  it('aborts without writing anything when overwrite is declined', async () => {
    const target = join(cwdDirectory, 'taken')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), '{}')
    mockConfirm.mockResolvedValue(false)
    mockPromptText.mockImplementation(async (message, fallback) => fallback ?? message)

    await runNew({ name: 'Taken' })

    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('already contains a package.json') }))
    expect(warnSpy).toHaveBeenCalledWith('! Aborted.')
    expect(isManagedRepo(target)).toBe(false)
  })

  it('continues when overwrite is accepted, even if a package.json already exists', async () => {
    const target = join(cwdDirectory, 'taken')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), '{}')
    mockConfirm.mockResolvedValue(true)

    await runNew({ name: 'Taken', scope: '@demo', organization: 'org', project: 'proj', feed: 'feed', base: 'main', lib: 'core' })

    expect(isManagedRepo(target)).toBe(true)
    expect(existsSync(join(target, 'libs/core/package.json'))).toBe(true)
  })

  it('prompts to add an initial library and uses the slugified answer', async () => {
    mockPromptText.mockImplementation(async (message, fallback) => (message === 'Library name' ? 'Custom Lib' : (fallback ?? message)))
    mockConfirm.mockResolvedValue(true)

    await runNew({ name: 'Interactive Repo', scope: '@demo', organization: 'org', project: 'proj', feed: 'feed', base: 'main' })

    const target = join(cwdDirectory, 'interactive-repo')
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Add an initial internal library now?' }))
    expect(existsSync(join(target, 'libs/custom-lib/package.json'))).toBe(true)
  })

  it('prompts for any individual field left unset in interactive mode', async () => {
    mockPromptText.mockImplementation(async (message, fallback) => fallback ?? message)

    await runNew({ name: 'Partial', project: 'proj', feed: 'feed', base: 'main', lib: 'core' })

    expect(mockPromptText).toHaveBeenCalledWith('Azure DevOps organization', 'my-org')
    expect(mockPromptText).toHaveBeenCalledWith('npm scope', '@auto')
    const target = join(cwdDirectory, 'partial')
    const registry = loadConfig(target)?.registry
    expect(registry?.kind).toBe('azure-artifacts')
    expect(registry?.kind === 'azure-artifacts' && registry.organization).toBe('my-org')
  })

  it('skips the initial library when the prompt is declined', async () => {
    mockPromptText.mockImplementation(async (message, fallback) => fallback ?? message)
    mockConfirm.mockResolvedValue(false)

    await runNew({ name: 'Interactive Repo', scope: '@demo', organization: 'org', project: 'proj', feed: 'feed', base: 'main' })

    const target = join(cwdDirectory, 'interactive-repo')
    expect(isManagedRepo(target)).toBe(true)
    expect(readdirSync(join(target, 'libs'))).toEqual(['.gitkeep'])
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Done. Next steps:'))
  })
})
