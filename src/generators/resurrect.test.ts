import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isManagedRepo, loadConfig } from '../engine/config'
import { readJsonSafe } from '../engine/fsx'
import { DEV_DEPENDENCIES } from '../templates/monorepo'
import { runResurrect } from './resurrect'

jest.mock('../util/prompts', () => ({
  checkbox:   jest.fn(),
  confirm:    jest.fn(),
  promptText: jest.fn(),
  select:     jest.fn(),
}))

import { checkbox, confirm, promptText, select } from '../util/prompts'

const mockCheckbox = jest.mocked(checkbox)
const mockConfirm = jest.mocked(confirm)
const mockPromptText = jest.mocked(promptText)
const mockSelect = jest.mocked(select)

let repoRoot: string
let errorSpy: jest.SpyInstance
let warnSpy: jest.SpyInstance

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'monecromanci-resurrect-'))
  jest.spyOn(process, 'cwd').mockReturnValue(repoRoot)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

  // Sensible interactive defaults: accept every prompt fallback, pick the
  // detected kind, confirm the hard prompt, and select every project.
  mockPromptText.mockImplementation(async (message, fallback) => fallback ?? message)
  mockSelect.mockImplementation(async ({ choices }) => (choices[0] as { value: unknown }).value)
  mockConfirm.mockResolvedValue(true)
  mockCheckbox.mockImplementation(async ({ choices }) => choices.map((choice) => (choice as { value: unknown }).value))
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

function writeRoot (manifest: Record<string, unknown> = {}): void {
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'legacy', private: true, ...manifest }))
}

function writeProject (area: 'apps' | 'libs', name: string, packageJson: Record<string, unknown>, extraFiles: Record<string, string> = {}): void {
  const directory = join(repoRoot, area, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify(packageJson))
  for (const [file, content] of Object.entries(extraFiles)) {
    writeFileSync(join(directory, file), content)
  }
}

function readJson (relativePath: string): Record<string, unknown> {
  return readJsonSafe<Record<string, unknown>>(join(repoRoot, relativePath), {})
}

describe('runResurrect', () => {
  it('errors when the directory has no package.json', async () => {
    await runResurrect()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No package.json found'))
    expect(isManagedRepo(repoRoot)).toBe(false)
  })

  it('adopts the root and every selected project without touching sources', async () => {
    writeRoot({ scripts: { test: 'vitest' }, devDependencies: { eslint: '^8.0.0' } })
    writeProject('apps', 'func', { name: '@demo/func', private: true, main: 'dist/index.js' }, { 'host.json': '{}' })
    writeProject('libs', 'helpers', { name: '@demo/helpers', private: true }, { 'jest.config.mjs': 'export default {}\n' })
    mkdirSync(join(repoRoot, 'libs', 'helpers', 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'libs', 'helpers', 'src', 'index.ts'), 'export const x = 1\n')

    await runResurrect()

    expect(isManagedRepo(repoRoot)).toBe(true)
    expect(loadConfig(repoRoot)?.workspaceName).toBe('legacy')
    expect(existsSync(join(repoRoot, 'nx.json'))).toBe(true)
    expect(existsSync(join(repoRoot, 'eslint.config.mjs'))).toBe(true)

    // Project tool-owned config written, with the tags that make re-runs skip them.
    expect((readJson('apps/func/project.json').tags as string[])).toEqual(['type:function-app'])
    expect((readJson('libs/helpers/project.json').tags as string[])).toEqual(['type:internal-lib'])

    // No sample sources planted; existing scaffold files kept.
    expect(existsSync(join(repoRoot, 'libs/helpers/src/greeter.ts'))).toBe(false)
    expect(existsSync(join(repoRoot, 'apps/func/src/greeting.ts'))).toBe(false)
    expect(readJsonSafe(join(repoRoot, 'libs/helpers/jest.config.mjs'))).toBeUndefined() // still the non-JSON user file

    // Toolchain pinned, user scripts kept, canonical scripts merged in.
    const manifest = readJson('package.json')
    expect((manifest.devDependencies as Record<string, string>).eslint).toBe(DEV_DEPENDENCIES.eslint)
    expect((manifest.scripts as Record<string, string>).test).toBe('vitest')
    expect((manifest.scripts as Record<string, string>).lint).toBeDefined()
    expect(manifest.workspaces).toEqual(['apps/*', 'libs/*'])

    // Per-project scripts merged into the existing manifests.
    expect((readJson('apps/func/package.json').scripts as Record<string, string>).lint).toBeDefined()
    expect((readJson('apps/func/package.json').name as string)).toBe('@demo/func')
  })

  it('aborts without changing anything when the hard confirmation is declined', async () => {
    writeRoot()
    writeProject('libs', 'helpers', { private: true })
    mockConfirm.mockResolvedValue(false)

    await runResurrect()

    expect(isManagedRepo(repoRoot)).toBe(false)
    expect(existsSync(join(repoRoot, 'nx.json'))).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Aborted'))
  })

  it('resumes on a second run: unselected projects are offered again, prompts are skipped', async () => {
    writeRoot()
    writeProject('apps', 'func', { name: '@demo/func', private: true }, { 'host.json': '{}' })
    writeProject('libs', 'helpers', { name: '@demo/helpers', private: true })

    // First run: only select the first project (apps/func).
    mockCheckbox.mockImplementationOnce(async ({ choices }) => [(choices[0] as { value: unknown }).value])
    await runResurrect()

    expect((readJson('apps/func/project.json').tags as string[])).toEqual(['type:function-app'])
    expect(existsSync(join(repoRoot, 'libs/helpers/project.json'))).toBe(false)

    // Second run: apps/func is recognised as managed, only libs/helpers is offered.
    mockSelect.mockClear()
    mockPromptText.mockClear()
    await runResurrect()

    expect(mockPromptText).not.toHaveBeenCalled() // stamp exists, no repo prompts
    expect(mockSelect).toHaveBeenCalledTimes(1)
    expect(mockSelect.mock.calls[0][0].message).toContain('libs/helpers')
    expect((readJson('libs/helpers/project.json').tags as string[])).toEqual(['type:internal-lib'])
  })

  it('skips a project whose confirmed kind contradicts its area folder', async () => {
    writeRoot()
    writeProject('libs', 'web', { name: '@demo/web', private: true, dependencies: { react: '^19.0.0' } })

    await runResurrect()

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('move it to apps/'))
    expect(existsSync(join(repoRoot, 'libs/web/project.json'))).toBe(false)
    expect(isManagedRepo(repoRoot)).toBe(true) // root was still resurrected
  })

  it('honours the skip choice and reports managed and out-of-layout projects', async () => {
    writeRoot({ workspaces: ['apps/*', 'packages/*'] })
    writeProject('libs', 'helpers', { private: true })
    writeProject('libs', 'done', { private: true })
    writeFileSync(join(repoRoot, 'libs', 'done', 'project.json'), JSON.stringify({ tags: ['type:internal-lib'] }))
    mkdirSync(join(repoRoot, 'packages', 'legacy'), { recursive: true })
    writeFileSync(join(repoRoot, 'packages', 'legacy', 'package.json'), '{}')
    mockSelect.mockImplementation(async ({ choices }) => (choices.at(-1) as { value: unknown }).value) // pick "Skip"

    await runResurrect()

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('packages/legacy'))
    expect(mockCheckbox).not.toHaveBeenCalled()
    expect(existsSync(join(repoRoot, 'libs/helpers/project.json'))).toBe(false)
    expect(isManagedRepo(repoRoot)).toBe(true)
  })

  it('resurrects the root alone when apps/ and libs/ are empty', async () => {
    writeRoot()

    await runResurrect()

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No projects found'))
    expect(isManagedRepo(repoRoot)).toBe(true)
    expect(existsSync(join(repoRoot, 'nx.json'))).toBe(true)
  })
})
