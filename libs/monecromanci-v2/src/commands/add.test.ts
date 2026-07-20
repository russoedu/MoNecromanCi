jest.mock('../nx', () => ({
  runNx:    jest.fn(),
  runShell: jest.fn(() => 0),
}))
jest.mock('../prompts', () => ({ promptText: jest.fn() }))
jest.mock('@inquirer/prompts', () => ({ select: jest.fn(), input: jest.fn() }))

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { select } from '@inquirer/prompts'
import { runNx, runShell } from '../nx'
import { promptText } from '../prompts'
import { runAdd, type ProjectKind } from './add'

const mockRunNx = jest.mocked(runNx)
const mockRunShell = jest.mocked(runShell)
const mockSelect = jest.mocked(select)
const mockPromptText = jest.mocked(promptText)

let workspaceRoot: string

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci2-add-'))
  // clearMocks resets call history but not implementations, so restore the
  // default (every shell command succeeds) in case a prior test overrode it.
  mockRunShell.mockImplementation(() => 0)
  jest.spyOn(process, 'cwd').mockReturnValue(workspaceRoot)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  writeFileSync(join(workspaceRoot, 'nx.json'), '{}')
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@demo/source', devDependencies: {} }))
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

/**
 * Dispatcher-level behaviour: the workspace-root check, kind/name resolution
 * and validation, the exhaustive-kind guard, and the post-add `nx sync`. Each
 * kind's own generation logic is tested where it lives — see
 * `add/reactApp.test.ts`, `add/functionApp.test.ts`, `add/npmLib.test.ts`
 * and `add/python.test.ts`; `internal-lib` stays here since its case is small
 * enough to stay inline in `add.ts`.
 */
describe('runAdd', () => {
  it('refuses to run outside a workspace root', async () => {
    rmSync(join(workspaceRoot, 'nx.json'))
    await expect(runAdd('react-app', 'web', {})).rejects.toThrow('No nx.json found here')
    expect(mockRunNx).not.toHaveBeenCalled()
  })

  it('syncs TypeScript project references after adding a project so cross-project imports resolve', async () => {
    await runAdd('react-app', 'web', {})

    // The --preset=ts model resolves cross-project imports via TS references,
    // which nx sync maintains — without this, an editor cannot autocomplete
    // @scope/lib imports until the user runs it by hand.
    expect(mockRunShell).toHaveBeenCalledWith('npx', ['nx', 'sync'], workspaceRoot)
  })

  it('keeps a successful add green even when nx sync fails (the project is already generated)', async () => {
    // Last call in the flow is nx sync; make only it fail.
    mockRunShell.mockImplementation((command: string, arguments_: string[]) => (command === 'npx' && arguments_[0] === 'nx' && arguments_[1] === 'sync' ? 1 : 0))

    await expect(runAdd('react-app', 'web', {})).resolves.toBeUndefined()
  })

  it('generates an internal lib under libs/ — buildable (tsc) but marked private', async () => {
    // The generator is mocked, so pre-create the manifest it would have written.
    mkdirSync(join(workspaceRoot, 'libs/utils'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'libs/utils/package.json'), JSON.stringify({ name: '@demo/utils' }))

    await runAdd('internal-lib', 'utils', {})

    expect(mockRunNx).toHaveBeenCalledWith([
      'g', '@nx/js:lib', 'libs/utils',
      '--bundler=tsc',
      '--unitTestRunner=jest',
      '--linter=eslint',
      '--no-interactive',
    ], workspaceRoot)
    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'libs/utils/package.json'), 'utf8')) as { private: boolean }
    expect(manifest.private).toBe(true)
  })

  it('prompts for the kind and name when omitted', async () => {
    mockSelect.mockResolvedValue('react-app')
    mockPromptText.mockResolvedValue('shop')

    await runAdd(undefined, undefined, {})

    expect(mockSelect).toHaveBeenCalled()
    expect(mockPromptText).toHaveBeenCalledWith('Project name')
    expect(mockRunNx.mock.calls.at(-1)?.[0]).toContain('apps/shop')
  })

  it('rejects an unrecognized kind with a clear error instead of a silent false "success" (defense in depth for a non-CLI caller)', async () => {
    // The CLI itself already rejects a bad kind before runAdd runs (commander
    // Argument#choices() in cli.ts); this proves runAdd's own switch has no
    // silent fallthrough for any other caller that bypasses that layer.
    await expect(runAdd('bogus-kind' as ProjectKind, 'thing', {})).rejects.toThrow('Unknown project kind \'bogus-kind\'')
    expect(mockRunNx).not.toHaveBeenCalled()
  })

  it('rejects an invalid project name before any install or generator call', async () => {
    await expect(runAdd('react-app', 'Not Valid!', {})).rejects.toThrow('Project name \'Not Valid!\' is invalid')

    expect(mockRunNx).not.toHaveBeenCalled()
    expect(mockRunShell).not.toHaveBeenCalled()
  })

  it('rejects an explicitly empty project name (bypasses promptText, since `??` only substitutes on undefined)', async () => {
    await expect(runAdd('react-app', '', {})).rejects.toThrow('Project name \'\' is invalid')

    expect(mockRunNx).not.toHaveBeenCalled()
  })
})
