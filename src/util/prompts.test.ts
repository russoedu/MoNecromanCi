import { input } from '@inquirer/prompts'
import { checkbox, confirm, input as reExportedInput, promptText, select } from './prompts'

jest.mock('@inquirer/prompts', () => ({
  checkbox: jest.fn(),
  select:   jest.fn(),
  confirm:  jest.fn(),
  input:    jest.fn(),
}))

const mockInput = jest.mocked(input)

describe('re-exports', () => {
  it('forwards checkbox, select, confirm and input from @inquirer/prompts', () => {
    const mocked = jest.requireMock<Record<string, unknown>>('@inquirer/prompts')
    expect(checkbox).toBe(mocked.checkbox)
    expect(select).toBe(mocked.select)
    expect(confirm).toBe(mocked.confirm)
    expect(reExportedInput).toBe(mocked.input)
  })
})

describe('promptText', () => {
  it('forwards the message and default, then trims the resolved value', async () => {
    mockInput.mockResolvedValue('  Ada  ')
    const value = await promptText('Name', 'fallback')
    expect(value).toBe('Ada')
    expect(mockInput).toHaveBeenCalledWith(expect.objectContaining({ message: 'Name', default: 'fallback' }))
  })

  it('works without a default', async () => {
    mockInput.mockResolvedValue('Bob')
    const value = await promptText('Name')
    expect(value).toBe('Bob')
    expect(mockInput).toHaveBeenCalledWith(expect.objectContaining({ message: 'Name', default: undefined }))
  })

  it('validates that a trimmed answer is required', async () => {
    mockInput.mockResolvedValue('value')
    await promptText('Name')
    const { validate } = mockInput.mock.calls[0][0] as { validate: (value: string) => boolean | string }
    expect(validate(' '.repeat(3))).toBe('A value is required')
    expect(validate('  ok  ')).toBe(true)
  })
})
