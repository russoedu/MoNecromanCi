jest.mock('commander', () => {
  type ActionHandler = (...parameters: unknown[]) => Promise<void> | void

  interface OptionDefinition {
    key:        string
    flags:      string
    takesValue: boolean
  }

  class FakeCommand {
    private readonly subcommands:       FakeCommand[] = []
    private readonly argumentNames:     string[] = []
    private readonly optionDefinitions: OptionDefinition[] = []
    private commandName = ''
    private actionHandler?:             ActionHandler

    name (): this { return this }
    description (): this { return this }
    version (): this { return this }

    command (nameAndArguments: string): FakeCommand {
      const subcommand = new FakeCommand()
      subcommand.commandName = nameAndArguments.split(' ', 1)[0]
      this.subcommands.push(subcommand)
      return subcommand
    }

    argument (flag: string): this {
      this.argumentNames.push(flag.replace(/^[[<]/, '').replace(/[\]>]$/, ''))
      return this
    }

    option (flags: string): this {
      const longFlagName = /--([\w-]+)/.exec(flags)?.[1] ?? ''
      const key = longFlagName.replaceAll(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
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
      const subcommand = this.subcommands.find((entry) => entry.commandName === commandToken)
      if (!subcommand) return this

      const options: Record<string, unknown> = {}
      const positionals: Array<string | undefined> = []
      for (let index = 0; index < rest.length; index++) {
        const token = rest[index]
        if (token.startsWith('-')) {
          const definition = subcommand.optionDefinitions.find((entry) => entry.flags.includes(token))
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

  return { Command: FakeCommand }
})

jest.mock('./commands/add', () => ({ runAdd: jest.fn(), PROJECT_KINDS: [] }))
jest.mock('./commands/new', () => ({ runNew: jest.fn() }))
jest.mock('./commands/interactive', () => ({ runInteractive: jest.fn() }))

import { buildProgram, main } from './cli'
import { runAdd } from './commands/add'
import { runInteractive } from './commands/interactive'
import { runNew } from './commands/new'

const mockRunAdd = jest.mocked(runAdd)
const mockRunNew = jest.mocked(runNew)
const mockRunInteractive = jest.mocked(runInteractive)

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
    await buildProgram().parseAsync(['node', 'mnci2', 'new', 'demo', '--yes', '--registry', 'npm'])
    expect(mockRunNew).toHaveBeenCalledWith('demo', expect.objectContaining({ yes: true, registry: 'npm' }))
  })

  it('routes `add` with kind, name and scope to runAdd', async () => {
    await buildProgram().parseAsync(['node', 'mnci2', 'add', 'npm-lib', 'sdk', '--scope', '@acme'])
    expect(mockRunAdd).toHaveBeenCalledWith('npm-lib', 'sdk', expect.objectContaining({ scope: '@acme' }))
  })

  it('runs the interactive wizard when invoked with no subcommand', async () => {
    await buildProgram().parseAsync(['node', 'mnci2'])
    expect(mockRunInteractive).toHaveBeenCalled()
    expect(mockRunNew).not.toHaveBeenCalled()
    expect(mockRunAdd).not.toHaveBeenCalled()
  })
})

describe('main', () => {
  it('logs command failures and sets a non-zero exit code instead of throwing', async () => {
    mockRunNew.mockRejectedValue(new Error('boom'))
    process.argv = ['node', 'mnci2', 'new', 'demo', '--yes']

    await main()

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('boom'))
    expect(process.exitCode).toBe(1)
  })

  it('stringifies non-Error failures', async () => {
    mockRunNew.mockRejectedValue('plain failure')
    process.argv = ['node', 'mnci2', 'new', 'demo', '--yes']

    await main()

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('plain failure'))
  })
})
