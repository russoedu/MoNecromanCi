import { input, select } from '@inquirer/prompts'
import {
  checkbox,
  confirm,
  input as reExportedInput,
  promptBranchList,
  promptDriftChoice,
  promptText,
  renderDiff,
  select as reExportedSelect,
  splitBranchList,
} from './prompts'

jest.mock('@inquirer/prompts', () => ({
  checkbox: jest.fn(),
  select:   jest.fn(),
  confirm:  jest.fn(),
  input:    jest.fn(),
}))

const mockInput = jest.mocked(input)
const mockSelect = jest.mocked(select)

describe('re-exports', () => {
  it('forwards checkbox, select, confirm and input from @inquirer/prompts', () => {
    const mocked = jest.requireMock<Record<string, unknown>>('@inquirer/prompts')
    expect(checkbox).toBe(mocked.checkbox)
    expect(reExportedSelect).toBe(mocked.select)
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

describe('splitBranchList', () => {
  it('splits, trims, dedupes and drops empties', () => {
    expect(splitBranchList('main, dev , , main,dev')).toEqual(['main', 'dev'])
  })

  it('preserves first-seen order', () => {
    expect(splitBranchList('c,a,b,a')).toEqual(['c', 'a', 'b'])
  })
})

describe('promptBranchList', () => {
  it('pre-fills the prompt with the joined fallback and splits the answer', async () => {
    mockInput.mockResolvedValue('main, dev')
    const branches = await promptBranchList('Branches', ['main'])
    expect(branches).toEqual(['main', 'dev'])
    expect(mockInput).toHaveBeenCalledWith(expect.objectContaining({ message: 'Branches', default: 'main' }))
  })

  it('validates that at least one branch remains after splitting', async () => {
    mockInput.mockResolvedValue('main')
    await promptBranchList('Branches', ['main'])
    const { validate } = mockInput.mock.calls[0][0] as { validate: (value: string) => boolean | string }
    expect(validate(' , ,')).toBe('At least one branch is required')
    expect(validate('main')).toBe(true)
  })
})

describe('renderDiff', () => {
  it('renders unchanged, added and removed lines with their prefixes', () => {
    const diff = renderDiff('keep\nold\n', 'keep\nnew\n')
    expect(diff).toContain('  keep')
    expect(diff).toContain('- old')
    expect(diff).toContain('+ new')
  })

  it('handles content with no trailing newline', () => {
    expect(renderDiff('a', 'b')).toBe('- a\n+ b')
  })
})

describe('promptDriftChoice', () => {
  it('offers update/skip/always/never and returns the chosen value', async () => {
    mockSelect.mockResolvedValue('always')
    const choice = await promptDriftChoice('eslint.config.mjs')
    expect(choice).toBe('always')

    const call = mockSelect.mock.calls[0][0] as { message: string, default: string, choices: Array<{ name: string, value: string }> }
    expect(call.message).toContain('eslint.config.mjs')
    expect(call.default).toBe('update')
    expect(call.choices.map((option) => option.value)).toEqual(['update', 'skip', 'always', 'never'])
    expect(call.choices.map((option) => option.name)).toEqual([
      'Update the file (just this once)',
      'Skip the file (just this once)',
      'Always update this file from now on',
      'Never update this file from now on',
    ])
  })
})
