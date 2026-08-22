jest.mock('../../nx', () => ({
  runNx: jest.fn(),
  runFormatter: jest.fn(),
  runShell: jest.fn(() => 0)
}))
jest.mock('../../prompts', () => ({ promptText: jest.fn() }))
jest.mock('@inquirer/prompts', () => ({ select: jest.fn(), input: jest.fn() }))

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runNx, runShell } from '../../nx'
import { promptText } from '../../prompts'
import { runAdd } from '../add'

const mockRunNx = jest.mocked(runNx)
const mockRunShell = jest.mocked(runShell)
const mockPromptText = jest.mocked(promptText)

let workspaceRoot: string

/**
 * The generator is mocked, so pre-create the manifest it would have written —
 * including the broken `types` paths `@nx/react:library --bundler=rollup`
 * actually emits, so the repair has something real to fix.
 */
function seedProjectManifest (projectRoot: string, name: string): void {
  mkdirSync(join(workspaceRoot, projectRoot), { recursive: true })
  writeFileSync(
    join(workspaceRoot, projectRoot, 'package.json'),
    JSON.stringify({
      name,
      main: './dist/index.esm.js',
      module: './dist/index.esm.js',
      types: './dist/index.esm.d.ts',
      exports: {
        './package.json': './package.json',
        '.': {
          types: './dist/index.esm.d.ts',
          import: './dist/index.esm.js',
          default: './dist/index.esm.js'
        }
      }
    })
  )
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-add-react-lib-'))
  mockRunShell.mockImplementation(() => 0)
  jest.spyOn(process, 'cwd').mockReturnValue(workspaceRoot)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  writeFileSync(join(workspaceRoot, 'nx.json'), '{}')
  writeFileSync(
    join(workspaceRoot, 'package.json'),
    JSON.stringify({ name: '@demo/source', devDependencies: {} })
  )
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

/** Every `nx g` invocation, flattened to one string per call. */
const generatorCalls = (): string[] =>
  mockRunNx.mock.calls.filter(([arguments_]) => arguments_[0] === 'g').map(([a]) => a.join(' '))

describe('react-lib', () => {
  it('delegates to @nx/react:library as a publishable rollup bundle under packages/', async () => {
    seedProjectManifest('packages/ui', '@demo/ui')

    await runAdd('react-lib', 'ui', {})

    const generate = generatorCalls().find(call => call.includes('@nx/react:library'))
    expect(generate).toContain('packages/ui')
    expect(generate).toContain('--publishable')
    expect(generate).toContain('--importPath=@demo/ui')
    // rollup, not the generator's own `none` default: it is what lets a
    // published package compile a private internal lib INTO its bundle without
    // the private name reaching the published manifest.
    expect(generate).toContain('--bundler=rollup')
    expect(generate).toContain('--linter=none')
  })

  it('marks the package public, or the first npm publish 402s on a scoped name', async () => {
    seedProjectManifest('packages/ui', '@demo/ui')

    await runAdd('react-lib', 'ui', {})

    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, 'packages/ui/package.json'), 'utf8')
    ) as { publishConfig?: { access?: string } }
    expect(manifest.publishConfig?.access).toBe('public')
  })

  it('honours an explicit --scope over the workspace default', async () => {
    seedProjectManifest('packages/ui', '@demo/ui')

    await runAdd('react-lib', 'ui', { scope: '@acme' })

    expect(generatorCalls().find(c => c.includes('@nx/react:library'))).toContain(
      '--importPath=@acme/ui'
    )
    expect(mockPromptText).not.toHaveBeenCalled()
  })

  it('installs @nx/react on first use', async () => {
    seedProjectManifest('packages/ui', '@demo/ui')

    await runAdd('react-lib', 'ui', {})

    expect(mockRunNx.mock.calls.some(([a]) => a[0] === 'add' && a[1] === '@nx/react')).toBe(true)
  })

  it('deletes the per-project ESLint config the generator writes', async () => {
    seedProjectManifest('packages/ui', '@demo/ui')
    writeFileSync(join(workspaceRoot, 'packages/ui/eslint.config.mjs'), 'export default []')

    await runAdd('react-lib', 'ui', {})

    // An mnci workspace has exactly one ESLint config, at the root.
    expect(existsSync(join(workspaceRoot, 'packages/ui/eslint.config.mjs'))).toBe(false)
  })

  it('repoints types at the declaration the rollup build actually emits', async () => {
    seedProjectManifest('packages/ui', '@demo/ui')

    await runAdd('react-lib', 'ui', {})

    // @nx/react:library --bundler=rollup writes types: './dist/index.esm.d.ts',
    // but its build emits dist/index.d.ts — so the referenced file never exists
    // and every consumer fails with TS7016 "Could not find a declaration file".
    // Verified against a real generated pair: typecheck fails before this, passes
    // after.
    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, 'packages/ui/package.json'), 'utf8')
    ) as { types?: string; main?: string; exports?: { '.': { types?: string } } }

    expect(manifest.types).toBe('./dist/index.d.ts')
    expect(manifest.exports?.['.'].types).toBe('./dist/index.d.ts')
    // main/module are correct as generated — index.esm.js IS emitted. Only the
    // declaration paths were wrong, so only those are touched.
    expect(manifest.main).toBe('./dist/index.esm.js')
  })

  it('leaves an already-correct types path alone, so an upstream fix is not overwritten', async () => {
    mkdirSync(join(workspaceRoot, 'packages/ui'), { recursive: true })
    writeFileSync(
      join(workspaceRoot, 'packages/ui/package.json'),
      JSON.stringify({ name: '@demo/ui', types: './dist/custom.d.ts' })
    )

    await runAdd('react-lib', 'ui', {})

    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, 'packages/ui/package.json'), 'utf8')
    ) as { types?: string }
    expect(manifest.types).toBe('./dist/custom.d.ts')
  })

  it('registers build and qa commands, but never start (a library has no dev server)', async () => {
    seedProjectManifest('packages/ui', '@demo/ui')

    await runAdd('react-lib', 'ui', {})

    const scripts = (
      JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    expect(scripts['ui:build']).toBe('nx run ui:build')
    expect(scripts['ui:qa']).toBe('nx run ui:lint && nx run ui:test')
    expect(scripts['ui:start']).toBeUndefined()
  })
})

describe('react-internal-lib', () => {
  it('lands in libs/ and is marked private, so it is structurally unpublishable', async () => {
    seedProjectManifest('libs/design', '@demo/design')

    await runAdd('react-internal-lib', 'design', {})

    const privateManifest = JSON.parse(
      readFileSync(join(workspaceRoot, 'libs/design/package.json'), 'utf8')
    ) as { types?: string }
    // The types repair applies to the private kind too — it is the one a
    // react-lib consumes, so a wrong declaration path breaks the consumer.
    expect(privateManifest.types).toBe('./dist/index.d.ts')

    const generate = generatorCalls().find(call => call.includes('@nx/react:library'))
    expect(generate).toContain('libs/design')
    expect(generate).not.toContain('--publishable')

    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, 'libs/design/package.json'), 'utf8')
    ) as { private?: boolean }
    expect(manifest.private).toBe(true)
  })

  it('is still buildable — enforce-module-boundaries forbids a buildable lib importing a non-buildable one', async () => {
    seedProjectManifest('libs/design', '@demo/design')

    await runAdd('react-internal-lib', 'design', {})

    // The generator's own default is `none`, which would make this lib
    // unimportable from any react-lib/npm-lib in the same workspace.
    expect(generatorCalls().find(c => c.includes('@nx/react:library'))).toContain(
      '--bundler=rollup'
    )
  })

  it('never prompts for a scope — a private lib is not published', async () => {
    seedProjectManifest('libs/design', '@demo/design')

    await runAdd('react-internal-lib', 'design', {})

    expect(mockPromptText).not.toHaveBeenCalled()
  })
})
