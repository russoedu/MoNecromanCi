jest.mock('@inquirer/prompts', () => ({ select: jest.fn() }))
jest.mock('./create-workspace.use-case', () => ({ runNew: jest.fn() }))
jest.mock('../project-scaffolding', () => ({
  ...jest.requireActual('../project-scaffolding'),
  runAdd: jest.fn(),
}))
jest.mock('../workspace-upgrade', () => ({ runUpgrade: jest.fn() }))
jest.mock('../file-system', () => ({ fileExists: jest.fn() }))

import { select } from '@inquirer/prompts'
import { fileExists } from '../file-system'
import { runAdd } from '../project-scaffolding'
import { runInteractive } from './interactive-wizard.use-case'
import { runNew } from './create-workspace.use-case'
import { runUpgrade } from '../workspace-upgrade'

const mockSelect = jest.mocked(select)
const mockFileExists = jest.mocked(fileExists)
const mockRunNew = jest.mocked(runNew)
const mockRunAdd = jest.mocked(runAdd)
const mockRunUpgrade = jest.mocked(runUpgrade)

afterEach(() => {
  jest.clearAllMocks()
})

describe('runInteractive', () => {
  it('dispatches to runNew (prompting everything) when the user picks "new"', async () => {
    mockFileExists.mockReturnValue(false)
    mockSelect.mockResolvedValue('new')

    await runInteractive()

    expect(mockRunNew).toHaveBeenCalledWith(undefined, {})
    expect(mockRunAdd).not.toHaveBeenCalled()
    expect(mockRunUpgrade).not.toHaveBeenCalled()
  })

  it('dispatches to runAdd (prompting everything) when the user picks "add"', async () => {
    mockFileExists.mockReturnValue(true)
    mockSelect.mockResolvedValue('add')

    await runInteractive()

    expect(mockRunAdd).toHaveBeenCalledWith(undefined, undefined, {})
    expect(mockRunNew).not.toHaveBeenCalled()
    expect(mockRunUpgrade).not.toHaveBeenCalled()
  })

  it('dispatches to runUpgrade against the current working directory when the user picks "upgrade"', async () => {
    mockFileExists.mockReturnValue(true)
    mockSelect.mockResolvedValue('upgrade')
    jest.spyOn(process, 'cwd').mockReturnValue('/somewhere/demo')

    await runInteractive()

    expect(mockRunUpgrade).toHaveBeenCalledWith('/somewhere/demo', {})
    expect(mockRunNew).not.toHaveBeenCalled()
    expect(mockRunAdd).not.toHaveBeenCalled()
  })

  it('offers "add" then "upgrade" then "new" inside a workspace, "new" first otherwise', async () => {
    mockSelect.mockResolvedValue('new')

    mockFileExists.mockReturnValue(true)
    await runInteractive()
    const insideChoices = (
      mockSelect.mock.calls[0][0] as unknown as { choices: Array<{ value: string }> }
    ).choices
    expect(insideChoices.map(choice => choice.value)).toEqual(['add', 'upgrade', 'new'])

    mockSelect.mockClear()
    mockFileExists.mockReturnValue(false)
    await runInteractive()
    const outsideChoices = (
      mockSelect.mock.calls[0][0] as unknown as { choices: Array<{ value: string }> }
    ).choices
    expect(outsideChoices.map(choice => choice.value)).toEqual(['new', 'add', 'upgrade'])
  })
})
