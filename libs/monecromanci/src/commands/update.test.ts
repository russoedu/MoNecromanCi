jest.mock('./doctor', () => ({ runDoctor: jest.fn() }))

import { runDoctor } from './doctor'
import { runUpdate } from './update'

describe('runUpdate', () => {
  it('delegates to doctor with apply enabled', async () => {
    await runUpdate()
    expect(runDoctor).toHaveBeenCalledWith({ apply: true })
  })
})
