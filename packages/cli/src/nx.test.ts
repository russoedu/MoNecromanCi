jest.mock('cross-spawn', () => ({ sync: jest.fn() }))

import spawn from 'cross-spawn'
import { runNpx, runNx, runFormatter, runShell } from './nx'
import { logger } from './util/logger'

const mockSpawnSync = jest.mocked(spawn.sync)

describe('runShell', () => {
  it('passes command and args as a real argv array (no shell line), inherits stdio, returns the exit status', () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawn.sync>)
    expect(runShell('npx', ['nx', 'graph'], '/repo')).toBe(0)
    expect(mockSpawnSync).toHaveBeenCalledWith('npx', ['nx', 'graph'], {
      stdio: 'inherit',
      cwd: '/repo'
    })
  })

  it('maps a null status (signal kill / spawn failure) to 1', () => {
    mockSpawnSync.mockReturnValue({ status: null } as ReturnType<typeof spawn.sync>)
    expect(runShell('npx', [], '/repo')).toBe(1)
  })

  it('passes a metacharacter-laden argument through as one literal argv entry, never shell-interpreted', () => {
    // The historical bug: `[command, ...args].join(' ')` + `shell: true` let a
    // value like this terminate the intended command and run a second one.
    // cross-spawn's array form has no shell in the loop, so it must arrive at
    // spawn.sync as a single, untouched array element.
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawn.sync>)
    const dangerous = 'x; touch pwned #'
    runShell('npx', ['nx', 'g', '@nx/react:app', `apps/${dangerous}`], '/repo')
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'npx',
      ['nx', 'g', '@nx/react:app', `apps/${dangerous}`],
      { stdio: 'inherit', cwd: '/repo' }
    )
  })
})

describe('runNx', () => {
  it('prefixes npx nx and passes the workspace cwd', () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawn.sync>)
    runNx(['g', '@nx/react:app', 'apps/web'], '/workspace')
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'npx',
      ['nx', 'g', '@nx/react:app', 'apps/web'],
      expect.objectContaining({ cwd: '/workspace' })
    )
  })

  it('throws with the failing command when nx exits non-zero', () => {
    mockSpawnSync.mockReturnValue({ status: 2 } as ReturnType<typeof spawn.sync>)
    expect(() => runNx(['g', 'x'], '/workspace')).toThrow('nx g x failed with exit code 2')
  })
})

describe('runNpx', () => {
  it('runs bare npx (for create-nx-workspace, outside any workspace)', () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawn.sync>)
    runNpx(['create-nx-workspace@latest', 'demo'], '/tmp')
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'npx',
      ['create-nx-workspace@latest', 'demo'],
      expect.objectContaining({ cwd: '/tmp' })
    )
  })

  it('throws when the process exits non-zero', () => {
    mockSpawnSync.mockReturnValue({ status: 1 } as ReturnType<typeof spawn.sync>)
    expect(() => runNpx(['boom'], '/tmp')).toThrow('npx boom failed with exit code 1')
  })
})

describe('runFormatter', () => {
  let warn: jest.SpyInstance

  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('formats the whole workspace by default', () => {
    // Nx's generators emit semicolons and double quotes, so without this pass a
    // generated workspace fails its own `lint` before the user has written a
    // line. ESLint is the formatter now, so this is `eslint --fix`.
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawn.sync>)

    runFormatter('/ws')

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'npx',
      ['eslint', '.', '--fix'],
      expect.objectContaining({ cwd: '/ws' })
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('formats a narrower target when one is given', () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawn.sync>)

    runFormatter('/ws', 'apps/web')

    expect(mockSpawnSync.mock.calls[0][1]).toContain('apps/web')
  })

  it('warns instead of throwing when the fix pass fails, and names the recovery command', () => {
    // Deliberately non-fatal: the project is fully generated and wired by the
    // time this runs, so aborting on a formatter hiccup would leave a perfectly
    // usable workspace stranded behind an error message.
    mockSpawnSync.mockReturnValue({ status: 2 } as ReturnType<typeof spawn.sync>)

    expect(() => {
      runFormatter('/ws')
    }).not.toThrow()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('npm run format'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exit code 2'))
  })

  it('treats a signal-killed run (null status) as a failure, not a success', () => {
    // runShell maps a null status to 1, so this must warn rather than read as
    // "formatted fine".
    mockSpawnSync.mockReturnValue({ status: null } as ReturnType<typeof spawn.sync>)

    runFormatter('/ws')

    expect(warn).toHaveBeenCalled()
  })
})
