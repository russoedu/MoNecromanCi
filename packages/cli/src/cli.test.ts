jest.mock('commander', () => {
  type ActionHandler = (...parameters: unknown[]) => Promise<void> | void

  interface OptionDefinition {
    key: string
    flags: string
    takesValue: boolean
  }

  class FakeCommand {
    private static stripBrackets (flag: string): string {
      return flag.replace(/^[[<]/, '').replace(/[\]>]$/, '')
    }

    private readonly subcommands: FakeCommand[] = []
    private readonly argumentNames: string[] = []
    private readonly optionDefinitions: OptionDefinition[] = []
    private commandName = ''
    private actionHandler?: ActionHandler

    name (): this {
      return this
    }

    description (): this {
      return this
    }

    version (): this {
      return this
    }

    command (nameAndArguments: string): FakeCommand {
      const subcommand = new FakeCommand()
      subcommand.commandName = nameAndArguments.split(' ', 1)[0]
      this.subcommands.push(subcommand)
      return subcommand
    }

    argument (flag: string): this {
      this.argumentNames.push(FakeCommand.stripBrackets(flag))
      return this
    }

    // Mirrors `.argument()` for the one place cli.ts uses `Argument#choices()`
    // (the `add` command's `[kind]`) — choice validation itself is proven
    // against the real `commander` package in cli.choices.test.ts, since a
    // hand-rolled mock re-implementing that validation would just be a second,
    // divergent copy of commander's own logic.
    addArgument (argument: { flag: string }): this {
      this.argumentNames.push(FakeCommand.stripBrackets(argument.flag))
      return this
    }

    option (flags: string): this {
      const longFlagName = /--([\w-]+)/.exec(flags)?.[1] ?? ''
      const key = longFlagName.replaceAll(/-([a-z])/g, (_match, letter: string) =>
        letter.toUpperCase()
      )
      const isTakesValue = /[<[]/.test(flags.split(',').pop() ?? flags)
      this.optionDefinitions.push({ key, flags, takesValue: isTakesValue })
      return this
    }

    action (handler: ActionHandler): this {
      this.actionHandler = handler
      return this
    }

    async parseAsync (argv: string[]): Promise<this> {
      const [commandToken, ...rest] = argv.slice(2)
      // Bare invocation (no subcommand token) runs the program's default action,
      // mirroring commander's own behaviour.
      if (commandToken === undefined) {
        await this.actionHandler?.()
        return this
      }
      const subcommand = this.subcommands.find(entry => entry.commandName === commandToken)
      if (!subcommand) return this

      const options: Record<string, unknown> = {}
      const positionals: Array<string | undefined> = []
      for (let index = 0; index < rest.length; index++) {
        const token = rest[index]
        if (token.startsWith('-')) {
          const definition = subcommand.optionDefinitions.find(entry => entry.flags.includes(token))
          if (definition) {
            options[definition.key] = definition.takesValue ? rest[++index] : true
          }
        } else {
          positionals.push(token)
        }
      }
      while (positionals.length < subcommand.argumentNames.length) positionals.push(undefined)

      await subcommand.actionHandler?.(...positionals, options)
      return this
    }
  }

  class FakeArgument {
    flag: string
    constructor (flag: string, _description?: string) {
      this.flag = flag
    }

    choices (_values: readonly string[]): this {
      return this
    }
  }

  return { Command: FakeCommand, Argument: FakeArgument }
})

jest.mock('./commands/add', () => ({ runAdd: jest.fn(), PROJECT_KINDS: [] }))
jest.mock('./commands/new', () => ({ runNew: jest.fn() }))
jest.mock('./commands/upgrade', () => ({ runUpgrade: jest.fn() }))
jest.mock('./commands/interactive', () => ({ runInteractive: jest.fn() }))
jest.mock('./util/versionChecker', () => ({
  checkForUpdate: jest.fn(),
  readCliVersion: jest.fn(() => '1.0.0')
}))

import { buildProgram, main } from './cli'
import { runAdd } from './commands/add'
import { runInteractive } from './commands/interactive'
import { runNew } from './commands/new'
import { runUpgrade } from './commands/upgrade'
import { checkForUpdate } from './util/versionChecker'

const mockRunAdd = jest.mocked(runAdd)
const mockRunNew = jest.mocked(runNew)
const mockRunUpgrade = jest.mocked(runUpgrade)
const mockRunInteractive = jest.mocked(runInteractive)
const mockCheckForUpdate = jest.mocked(checkForUpdate)

let errorSpy: jest.SpyInstance

beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
  process.exitCode = 0
})

describe('buildProgram', () => {
  it('routes `new` with its flags to runNew', async () => {
    await buildProgram('1.0.0').parseAsync([
      'node',
      'mnci',
      'new',
      'demo',
      '--yes',
      '--registry',
      'npm'
    ])
    expect(mockRunNew).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({ yes: true, registry: 'npm' })
    )
  })

  it('routes `add` with kind, name and scope to runAdd', async () => {
    await buildProgram('1.0.0').parseAsync([
      'node',
      'mnci',
      'add',
      'npm-lib',
      'sdk',
      '--scope',
      '@acme'
    ])
    expect(mockRunAdd).toHaveBeenCalledWith(
      'npm-lib',
      'sdk',
      expect.objectContaining({ scope: '@acme' })
    )
  })

  it("routes `add node-app`'s --framework flag to runAdd", async () => {
    await buildProgram('1.0.0').parseAsync([
      'node',
      'mnci',
      'add',
      'node-app',
      'api',
      '--framework',
      'fastify'
    ])
    expect(mockRunAdd).toHaveBeenCalledWith(
      'node-app',
      'api',
      expect.objectContaining({ framework: 'fastify' })
    )
  })

  it("routes `add python-vendor`'s --lib flag to runAdd", async () => {
    await buildProgram('1.0.0').parseAsync([
      'node',
      'mnci',
      'add',
      'python-vendor',
      'svc',
      '--lib',
      'pycore'
    ])
    expect(mockRunAdd).toHaveBeenCalledWith(
      'python-vendor',
      'svc',
      expect.objectContaining({ lib: 'pycore' })
    )
  })

  it('routes `new` test-runner flag to runNew', async () => {
    await buildProgram('1.0.0').parseAsync([
      'node',
      'mnci',
      'new',
      'demo',
      '--yes',
      '--test-runner',
      'vitest'
    ])
    expect(mockRunNew).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({ testRunner: 'vitest' })
    )
  })

  it("routes `new`'s --ci flag to runNew", async () => {
    await buildProgram('1.0.0').parseAsync([
      'node',
      'mnci',
      'new',
      'demo',
      '--yes',
      '--ci',
      'github'
    ])
    expect(mockRunNew).toHaveBeenCalledWith('demo', expect.objectContaining({ ci: 'github' }))
  })

  it("routes `new`'s --nx-cloud flag to runNew", async () => {
    await buildProgram('1.0.0').parseAsync(['node', 'mnci', 'new', 'demo', '--yes', '--nx-cloud'])
    expect(mockRunNew).toHaveBeenCalledWith('demo', expect.objectContaining({ nxCloud: true }))
  })

  it('routes `upgrade` with its flags to runUpgrade, against the current working directory', async () => {
    jest.spyOn(process, 'cwd').mockReturnValue('/somewhere/demo')
    await buildProgram('1.0.0').parseAsync(['node', 'mnci', 'upgrade', '--agent', 'windows-latest'])
    expect(mockRunUpgrade).toHaveBeenCalledWith(
      '/somewhere/demo',
      expect.objectContaining({ agent: 'windows-latest' })
    )
  })

  it('runs the interactive wizard when invoked with no subcommand', async () => {
    await buildProgram('1.0.0').parseAsync(['node', 'mnci'])
    expect(mockRunInteractive).toHaveBeenCalled()
    expect(mockRunNew).not.toHaveBeenCalled()
    expect(mockRunAdd).not.toHaveBeenCalled()
  })
})

describe('main', () => {
  it('logs command failures and sets a non-zero exit code instead of throwing', async () => {
    mockRunNew.mockRejectedValue(new Error('boom'))
    process.argv = ['node', 'mnci', 'new', 'demo', '--yes']

    await main()

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'))
    expect(process.exitCode).toBe(1)
  })

  it('stringifies non-Error failures', async () => {
    mockRunNew.mockRejectedValue('plain failure')
    process.argv = ['node', 'mnci', 'new', 'demo', '--yes']

    await main()

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('plain failure'))
  })

  it('kicks off a background update check with the running version', async () => {
    process.argv = ['node', 'mnci', 'new', 'demo', '--yes']

    await main()

    expect(mockCheckForUpdate).toHaveBeenCalledWith('1.0.0')
  })

  it('does not let the update check delay or fail the command', async () => {
    // checkForUpdate is void-returning by design: anything promise-shaped
    // here would be a floating promise at the call site, and a rejected one
    // would take the process down with an unhandled rejection.
    // The preceding cases set a persistent rejection on runNew (restoreAllMocks
    // does not reset jest.mock factory fns), so re-arm it for the happy path.
    mockRunNew.mockResolvedValue(undefined)
    process.argv = ['node', 'mnci', 'new', 'demo', '--yes']

    await main()

    expect(mockCheckForUpdate).toHaveReturnedWith(undefined)
    expect(mockRunNew).toHaveBeenCalled()
    expect(process.exitCode).toBe(0)
  })

  describe('version banner', () => {
    let logSpy: jest.SpyInstance
    let isTTY: boolean | undefined

    beforeEach(() => {
      mockRunNew.mockResolvedValue(undefined)
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
      isTTY = process.stdout.isTTY
    })

    afterEach(() => {
      process.stdout.isTTY = isTTY as boolean
    })

    it('prints "mnci v<version>" for an interactive (TTY) invocation', async () => {
      process.stdout.isTTY = true
      process.argv = ['node', 'mnci', 'new', 'demo', '--yes']

      await main()

      expect(logSpy).toHaveBeenCalledWith('mnci v1.0.0')
    })

    it('stays silent for a non-TTY invocation (CI, piped output)', async () => {
      process.stdout.isTTY = false
      process.argv = ['node', 'mnci', 'new', 'demo', '--yes']

      await main()

      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('mnci v'))
    })

    it('skips the banner when -v/--version was passed, to avoid a redundant duplicate', async () => {
      process.stdout.isTTY = true

      process.argv = ['node', 'mnci', '-v']
      await main()
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('mnci v'))

      logSpy.mockClear()
      process.argv = ['node', 'mnci', '--version']
      await main()
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('mnci v'))
    })
  })
})
