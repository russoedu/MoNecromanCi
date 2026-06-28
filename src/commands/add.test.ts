jest.mock('../generators/addProject', () => ({ runAdd: jest.fn() }))

import { runAdd as runAddProject } from '../generators/addProject'
import { runAdd } from './add'

describe('add command', () => {
  it('re-exports the addProject generator', async () => {
    expect(runAdd).toBe(runAddProject)
    await runAdd({ type: 'internal-lib', name: 'foo' })
    expect(runAddProject).toHaveBeenCalledWith({ type: 'internal-lib', name: 'foo' })
  })
})
