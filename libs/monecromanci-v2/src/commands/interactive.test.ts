jest.mock('@inquirer/prompts', () => ({ select: jest.fn() }))
jest.mock('./new', () => ({ runNew: jest.fn() }))
jest.mock('./add', () => ({ runAdd: jest.fn() }))
jest.mock('../util/fsx', () => ({ fileExists: jest.fn() }))

import { select } from '@inquirer/prompts'
import { fileExists } from '../util/fsx'
import { runAdd } from './add'
import { runInteractive } from './interactive'
import { runNew } from './new'

const mockSelect = jest.mocked(select)
const mockFileExists = jest.mocked(fileExists)
const mockRunNew = jest.mocked(runNew)
const mockRunAdd = jest.mocked(runAdd)

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
  })

  it('dispatches to runAdd (prompting everything) when the user picks "add"', async () => {
    mockFileExists.mockReturnValue(true)
    mockSelect.mockResolvedValue('add')

    await runInteractive()

    expect(mockRunAdd).toHaveBeenCalledWith(undefined, undefined, {})
    expect(mockRunNew).not.toHaveBeenCalled()
  })

  it('offers "add" first inside a workspace, "new" first otherwise', async () => {
    mockSelect.mockResolvedValue('new')

    mockFileExists.mockReturnValue(true)
    await runInteractive()
    const insideChoices = (mockSelect.mock.calls[0][0] as unknown as { choices: Array<{ value: string }> }).choices
    expect(insideChoices.map((choice) => choice.value)).toEqual(['add', 'new'])

    mockSelect.mockClear()
    mockFileExists.mockReturnValue(false)
    await runInteractive()
    const outsideChoices = (mockSelect.mock.calls[0][0] as unknown as { choices: Array<{ value: string }> }).choices
    expect(outsideChoices.map((choice) => choice.value)).toEqual(['new', 'add'])
  })
})
