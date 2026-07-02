jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }))

import { spawnSync } from 'node:child_process'
import { runShell } from './exec'

const mockSpawnSync = jest.mocked(spawnSync)

describe('runShell', () => {
  it('joins the command and arguments into one shell line and inherits stdio', () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)

    const status = runShell('npx', ['nx', 'affected', '-t', 'lint'], '/repo')

    expect(status).toBe(0)
    expect(mockSpawnSync).toHaveBeenCalledWith('npx nx affected -t lint', { stdio: 'inherit', shell: true, cwd: '/repo' })
  })

  it('passes through a non-zero exit status', () => {
    mockSpawnSync.mockReturnValue({ status: 3 } as ReturnType<typeof spawnSync>)
    expect(runShell('npx', ['nx', 'run-many'], '/repo')).toBe(3)
  })

  it('returns 1 when the process never produced a status (signal or spawn failure)', () => {
    mockSpawnSync.mockReturnValue({ status: null } as ReturnType<typeof spawnSync>)
    expect(runShell('npx', [], '/repo')).toBe(1)
  })
})
