jest.mock('../generators/resurrect', () => ({ runResurrect: jest.fn() }))

import { runResurrect as runGenerator } from '../generators/resurrect'
import { runResurrect } from './resurrect'

describe('resurrect command', () => {
  it('re-exports the resurrect generator', async () => {
    expect(runResurrect).toBe(runGenerator)
    await runResurrect()
    expect(runGenerator).toHaveBeenCalled()
  })
})
