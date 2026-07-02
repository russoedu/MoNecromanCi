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
    private aliasName?:                 string
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

    alias (aliasName: string): this {
      this.aliasName = aliasName
      return this
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
      const subcommand = this.subcommands.find((entry) => entry.commandName === commandToken || entry.aliasName === commandToken)
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

jest.mock('./commands/new', () => ({ runNew: jest.fn() }))
jest.mock('./commands/add', () => ({ runAdd: jest.fn() }))
jest.mock('./commands/doctor', () => ({ runDoctor: jest.fn() }))
jest.mock('./commands/update', () => ({ runUpdate: jest.fn() }))
jest.mock('./commands/resurrect', () => ({ runResurrect: jest.fn() }))

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

interface CommandMocks {
  runNew:       jest.MockedFunction<typeof import('./commands/new').runNew>
  runAdd:       jest.MockedFunction<typeof import('./commands/add').runAdd>
  runDoctor:    jest.MockedFunction<typeof import('./commands/doctor').runDoctor>
  runUpdate:    jest.MockedFunction<typeof import('./commands/update').runUpdate>
  runResurrect: jest.MockedFunction<typeof import('./commands/resurrect').runResurrect>
}

/**
 * jest.isolateModulesAsync runs in a sandboxed module registry, so the
 * command mocks it resolves are distinct instances from anything imported
 * at the top of this file. Grab the references from inside the sandbox.
 */
async function loadCli (configure?: (mocks: CommandMocks) => void): Promise<CommandMocks> {
  let mocks!: CommandMocks
  await jest.isolateModulesAsync(async () => {
    const { runNew } = await import('./commands/new')
    const { runAdd } = await import('./commands/add')
    const { runDoctor } = await import('./commands/doctor')
    const { runUpdate } = await import('./commands/update')
    const { runResurrect } = await import('./commands/resurrect')
    mocks = {
      runNew:       jest.mocked(runNew),
      runAdd:       jest.mocked(runAdd),
      runDoctor:    jest.mocked(runDoctor),
      runUpdate:    jest.mocked(runUpdate),
      runResurrect: jest.mocked(runResurrect),
    }
    mocks.runNew.mockResolvedValue()
    mocks.runAdd.mockResolvedValue()
    mocks.runDoctor.mockResolvedValue()
    mocks.runUpdate.mockResolvedValue()
    mocks.runResurrect.mockResolvedValue()
    configure?.(mocks)

    await import('./cli')
    await flush()
  })
  return mocks
}

const originalArgv = process.argv
const originalExitCode = process.exitCode

afterEach(() => {
  process.argv = originalArgv
  process.exitCode = originalExitCode
  jest.restoreAllMocks()
})

describe('cli', () => {
  it('reads its version from the packaged package.json', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {})
    process.argv = ['node', 'cli.js', 'doctor']
    const mocks = await loadCli()
    expect(mocks.runDoctor).toHaveBeenCalledWith({ apply: false })
  })

  it('falls back to 0.0.0 when the packaged package.json has no version field', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.doMock('node:fs', () => ({
      ...jest.requireActual('node:fs'),
      readFileSync: jest.fn(() => '{}'),
    }))
    process.argv = ['node', 'cli.js', 'update']
    const mocks = await loadCli()
    expect(mocks.runUpdate).toHaveBeenCalled()
  })

  it('falls back to 0.0.0 when the version file cannot be read', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.doMock('node:fs', () => ({
      ...jest.requireActual('node:fs'),
      readFileSync: jest.fn(() => {
        throw new Error('no package.json here')
      }),
    }))
    process.argv = ['node', 'cli.js', 'update']
    const mocks = await loadCli()
    expect(mocks.runUpdate).toHaveBeenCalled()
  })

  it('maps "new" flags onto runNew options', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {})
    process.argv = [
      'node', 'cli.js', 'new', 'demo',
      '--yes', '--scope', '@demo', '--org', 'my-org', '--project', 'Automation',
      '--feed', 'AUTO', '--base', 'main', '--lib', 'helpers',
    ]
    const mocks = await loadCli()
    expect(mocks.runNew).toHaveBeenCalledWith({
      name:         'demo',
      yes:          true,
      scope:        '@demo',
      organization: 'my-org',
      project:      'Automation',
      feed:         'AUTO',
      base:         'main',
      lib:          'helpers',
    })
  })

  it('passes positional args through to runAdd', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {})
    process.argv = ['node', 'cli.js', 'add', 'internal-lib', 'foo']
    const mocks = await loadCli()
    expect(mocks.runAdd).toHaveBeenCalledWith({ type: 'internal-lib', name: 'foo' })
  })

  it('maps --fix to apply on the doctor command, including its alias', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {})
    process.argv = ['node', 'cli.js', 'fix', '--fix']
    const mocks = await loadCli()
    expect(mocks.runDoctor).toHaveBeenCalledWith({ apply: true })
  })

  it('dispatches resurrect, including its adopt alias', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {})
    process.argv = ['node', 'cli.js', 'adopt']
    const mocks = await loadCli()
    expect(mocks.runResurrect).toHaveBeenCalled()
  })

  it('logs the error message and sets a failing exit code when a command rejects', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(console, 'log').mockImplementation(() => {})
    process.argv = ['node', 'cli.js', 'update']
    await loadCli((mocks) => mocks.runUpdate.mockReset().mockRejectedValue(new Error('boom')))
    expect(errorSpy).toHaveBeenCalledWith('✗ boom')
    expect(process.exitCode).toBe(1)
  })

  it('stringifies non-Error rejections', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(console, 'log').mockImplementation(() => {})
    process.argv = ['node', 'cli.js', 'update']
    await loadCli((mocks) => mocks.runUpdate.mockReset().mockRejectedValue('plain string failure'))
    expect(errorSpy).toHaveBeenCalledWith('✗ plain string failure')
    expect(process.exitCode).toBe(1)
  })
})
