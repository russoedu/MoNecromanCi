jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }))

import { spawnSync } from 'node:child_process'
import { quote, runNpx, runNx, runShell } from './nx'

const mockSpawnSync = jest.mocked(spawnSync)

describe('runShell', () => {
  it('joins the command line, inherits stdio and returns the exit status', () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)
    expect(runShell('npx', ['nx', 'graph'], '/repo')).toBe(0)
    expect(mockSpawnSync).toHaveBeenCalledWith('npx nx graph', { stdio: 'inherit', shell: true, cwd: '/repo' })
  })

  it('maps a null status (signal kill / spawn failure) to 1', () => {
    mockSpawnSync.mockReturnValue({ status: null } as ReturnType<typeof spawnSync>)
    expect(runShell('npx', [], '/repo')).toBe(1)
  })
})

describe('quote', () => {
  it('wraps a value in double quotes', () => {
    expect(quote('HTTP trigger')).toBe('"HTTP trigger"')
  })

  it('refuses values containing a double quote', () => {
    expect(() => quote('a"b')).toThrow('Refusing to shell-quote')
  })
})

describe('runNx', () => {
  it('prefixes npx nx and passes the workspace cwd', () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)
    runNx(['g', '@nx/react:app', 'apps/web'], '/workspace')
    expect(mockSpawnSync).toHaveBeenCalledWith('npx nx g @nx/react:app apps/web', expect.objectContaining({ cwd: '/workspace' }))
  })

  it('throws with the failing command when nx exits non-zero', () => {
    mockSpawnSync.mockReturnValue({ status: 2 } as ReturnType<typeof spawnSync>)
    expect(() => runNx(['g', 'x'], '/workspace')).toThrow('nx g x failed with exit code 2')
  })
})

describe('runNpx', () => {
  it('runs bare npx (for create-nx-workspace, outside any workspace)', () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)
    runNpx(['create-nx-workspace@latest', 'demo'], '/tmp')
    expect(mockSpawnSync).toHaveBeenCalledWith('npx create-nx-workspace@latest demo', expect.objectContaining({ cwd: '/tmp' }))
  })

  it('throws when the process exits non-zero', () => {
    mockSpawnSync.mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>)
    expect(() => runNpx(['boom'], '/tmp')).toThrow('npx boom failed with exit code 1')
  })
})
