jest.mock('../generators/createMonorepo', () => ({ runNew: jest.fn() }))

import { runNew as runCreateMonorepo } from '../generators/createMonorepo'
import { runNew } from './new'

describe('new command', () => {
  it('re-exports the createMonorepo generator', async () => {
    expect(runNew).toBe(runCreateMonorepo)
    await runNew({ name: 'demo' })
    expect(runCreateMonorepo).toHaveBeenCalledWith({ name: 'demo' })
  })
})
