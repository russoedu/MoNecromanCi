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
    // generated workspace fails its own `format:check` before the user has
    // written a line.
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawn.sync>)

    runFormatter('/ws', 'eslint')

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'npx',
      ['prettier', '--write', '--log-level', 'warn', '.'],
      expect.objectContaining({ cwd: '/ws' })
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('formats a narrower target when one is given', () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawn.sync>)

    runFormatter('/ws', 'eslint', 'apps/web')

    expect(mockSpawnSync.mock.calls[0][1]).toContain('apps/web')
  })

  it('warns instead of throwing when Prettier fails, and names the recovery command', () => {
    // Deliberately non-fatal: the project is fully generated and wired by the
    // time this runs, so aborting on a formatter hiccup would leave a perfectly
    // usable workspace stranded behind an error message.
    mockSpawnSync.mockReturnValue({ status: 2 } as ReturnType<typeof spawn.sync>)

    expect(() => {
      runFormatter('/ws', 'eslint')
    }).not.toThrow()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('npm run format'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exit code 2'))
  })

  it('runs oxfmt, not Prettier, in an oxlint workspace', () => {
    // THE bug this function was renamed for. Hardcoding Prettier here did not
    // fail loudly in an oxlint workspace — the overlay deletes `.prettierrc.mjs`,
    // so `npx prettier --write .` succeeded and formatted the whole workspace
    // against PRETTIER'S OWN DEFAULTS: semicolons, double quotes, trailing
    // commas, the exact opposite of the shared opinion, applied to files mnci
    // had just written correctly. `oxfmt --check` then reported 19 files
    // unformatted in a freshly generated workspace, `eslint.config.mjs` and
    // `oxlint.config.ts` among them. Found by the real e2e; no unit test
    // existed to catch it because this function took no linter at all.
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawn.sync>)

    runFormatter('/ws', 'oxlint')

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'npx',
      ['oxfmt', '--write', '.'],
      expect.objectContaining({ cwd: '/ws' })
    )
  })

  it("never invokes the other mode's formatter, in either direction", () => {
    // The property, rather than two examples of it: whichever formatter runs,
    // the other one must not be reachable in that call. Two formatters over one
    // tree is the `.prettierrc` precedence bug — both succeed, they disagree,
    // and whichever ran last wins.
    for (const [linter, expected, forbidden] of [
      ['eslint', 'prettier', 'oxfmt'],
      ['oxlint', 'oxfmt', 'prettier']
    ] as const) {
      mockSpawnSync.mockClear()
      mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawn.sync>)

      runFormatter('/ws', linter)

      const arguments_ = mockSpawnSync.mock.calls[0][1] as string[]
      expect(arguments_).toContain(expected)
      expect(arguments_).not.toContain(forbidden)
    }
  })

  it('names the formatter that actually failed, not always Prettier', () => {
    // The warning is the only thing a user sees when this goes wrong, so it has
    // to name the binary they would re-run.
    mockSpawnSync.mockReturnValue({ status: 2 } as ReturnType<typeof spawn.sync>)

    runFormatter('/ws', 'oxlint')

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('oxfmt'))
  })

  it('treats a signal-killed Prettier (null status) as a failure, not a success', () => {
    // runShell maps a null status to 1, so this must warn rather than read as
    // "formatted fine".
    mockSpawnSync.mockReturnValue({ status: null } as ReturnType<typeof spawn.sync>)

    runFormatter('/ws', 'eslint')

    expect(warn).toHaveBeenCalled()
  })
})
