jest.mock('../util/prompts', () => ({ confirm: jest.fn(), select: jest.fn() }))
jest.mock('./add', () => ({ runAdd: jest.fn() }))
jest.mock('./doctor', () => ({ runDoctor: jest.fn() }))
jest.mock('./new', () => ({ runNew: jest.fn() }))
jest.mock('./resurrect', () => ({ runResurrect: jest.fn() }))
jest.mock('./update', () => ({ runUpdate: jest.fn() }))
jest.mock('./validate', () => ({ runValidate: jest.fn() }))

import { confirm, select } from '../util/prompts'
import { runAdd } from './add'
import { runDoctor } from './doctor'
import { runInteractive } from './interactive'
import { runNew } from './new'
import { runResurrect } from './resurrect'
import { runUpdate } from './update'
import { runValidate } from './validate'

const mockSelect = jest.mocked(select)
const mockConfirm = jest.mocked(confirm)

afterEach(() => {
  jest.clearAllMocks()
})

describe('runInteractive', () => {
  it('offers every command plus an exit entry', async () => {
    mockSelect.mockResolvedValue('exit' as never)

    await runInteractive()

    const { choices } = mockSelect.mock.calls[0][0] as unknown as { choices: Array<{ value: string }> }
    expect(choices.map((choice) => choice.value)).toEqual(['new', 'add', 'resurrect', 'doctor', 'update', 'validate', 'exit'])
  })

  it('dispatches new/add/resurrect/update to their interactive flows', async () => {
    for (const [action, mock] of [
      ['new', runNew],
      ['add', runAdd],
      ['resurrect', runResurrect],
      ['update', runUpdate],
    ] as const) {
      mockSelect.mockResolvedValueOnce(action as never)
      await runInteractive()
      expect(mock).toHaveBeenCalled()
    }
    expect(runNew).toHaveBeenCalledWith({})
    expect(runAdd).toHaveBeenCalledWith({})
    expect(mockConfirm).not.toHaveBeenCalled()
  })

  it('asks whether to apply fixes before running doctor', async () => {
    mockSelect.mockResolvedValue('doctor' as never)
    mockConfirm.mockResolvedValue(true)

    await runInteractive()

    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('--fix') }))
    expect(runDoctor).toHaveBeenCalledWith({ apply: true })
  })

  it('asks whether to validate every project before running validate', async () => {
    mockSelect.mockResolvedValue('validate' as never)
    mockConfirm.mockResolvedValue(false)

    await runInteractive()

    expect(runValidate).toHaveBeenCalledWith({ all: false })
  })

  it('does nothing when the user exits', async () => {
    mockSelect.mockResolvedValue('exit' as never)

    await runInteractive()

    for (const mock of [runNew, runAdd, runResurrect, runDoctor, runUpdate, runValidate]) {
      expect(mock).not.toHaveBeenCalled()
    }
  })
})
