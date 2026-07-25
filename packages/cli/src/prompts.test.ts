jest.mock('@inquirer/prompts', () => ({ confirm: jest.fn(), input: jest.fn(), select: jest.fn() }))

import { confirm, input, select } from '@inquirer/prompts'
import { promptCi, promptNxCloud, promptRegistry, promptText } from './prompts'

const mockConfirm = jest.mocked(confirm)
const mockInput = jest.mocked(input)
const mockSelect = jest.mocked(select)

describe('promptText', () => {
  it('forwards the message and default, then trims the resolved value', async () => {
    mockInput.mockResolvedValue('  Ada  ')
    const value = await promptText('Name', 'fallback')
    expect(value).toBe('Ada')
    expect(mockInput).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Name', default: 'fallback' })
    )
  })

  it('validates that a trimmed answer is required', async () => {
    mockInput.mockResolvedValue('value')
    await promptText('Name')
    const { validate } = mockInput.mock.calls[0][0] as {
      validate: (value: string) => boolean | string
    }
    expect(validate(' '.repeat(3))).toBe('A value is required')
    expect(validate('  ok  ')).toBe(true)
  })
})

describe('promptRegistry', () => {
  it('returns npm directly with no follow-up prompts', async () => {
    mockSelect.mockResolvedValue('npm')
    expect(await promptRegistry()).toEqual({ kind: 'npm' })
    expect(mockInput).not.toHaveBeenCalled()
  })

  it('collects the three Azure Artifacts coordinates', async () => {
    mockSelect.mockResolvedValue('azure-artifacts')
    mockInput
      .mockResolvedValueOnce('org')
      .mockResolvedValueOnce('proj')
      .mockResolvedValueOnce('feed')

    expect(await promptRegistry('default-org')).toEqual({
      kind: 'azure-artifacts',
      organization: 'org',
      project: 'proj',
      artifactsFeed: 'feed',
    })
    expect(mockInput).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Azure DevOps organization', default: 'default-org' })
    )
  })
})

describe('promptCi', () => {
  it('offers Azure Pipelines, GitHub Actions and both, in that order', async () => {
    mockSelect.mockResolvedValue('github')
    expect(await promptCi()).toBe('github')
    const { choices } = mockSelect.mock.calls[0][0] as unknown as {
      choices: Array<{ value: string }>
    }
    expect(choices.map(choice => choice.value)).toEqual(['azure', 'github', 'both'])
  })
})

describe('promptNxCloud', () => {
  it('defaults to declined and forwards the resolved answer', async () => {
    mockConfirm.mockResolvedValue(true)
    expect(await promptNxCloud()).toBe(true)
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ default: false }))
  })
})
