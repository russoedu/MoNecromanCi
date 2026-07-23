jest.mock('../../nx', () => ({
  runNx:    jest.fn(),
  runShell: jest.fn(() => 0),
}))
jest.mock('../../prompts', () => ({ promptText: jest.fn() }))
jest.mock('@inquirer/prompts', () => ({ select: jest.fn(), input: jest.fn() }))

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runNx, runShell } from '../../nx'
import { runAdd } from '../add'

const mockRunNx = jest.mocked(runNx)
const mockRunShell = jest.mocked(runShell)

let workspaceRoot: string

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-add-node-'))
  mockRunShell.mockImplementation(() => 0)
  jest.spyOn(process, 'cwd').mockReturnValue(workspaceRoot)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  writeFileSync(join(workspaceRoot, 'nx.json'), '{}')
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@demo/source', devDependencies: {} }))
  mkdirSync(join(workspaceRoot, 'node_modules/@azure/functions'), { recursive: true })
  writeFileSync(join(workspaceRoot, 'node_modules/@azure/functions/package.json'), JSON.stringify({ version: '4.16.2' }))
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

describe('runAdd node-app', () => {
  it('installs @nx/node on first use, then delegates to the plain application generator', async () => {
    await runAdd('node-app', 'svc', {})

    expect(mockRunNx).toHaveBeenNthCalledWith(1, ['add', '@nx/node'], workspaceRoot)
    expect(mockRunNx).toHaveBeenNthCalledWith(2, [
      'g', '@nx/node:application', 'apps/svc',
      '--bundler=esbuild',
      '--unitTestRunner=jest',
      '--linter=eslint',
      '--e2eTestRunner=none',
      '--framework=none',
      '--no-interactive',
    ], workspaceRoot)
  })

  it('skips the plugin install when it is already a devDependency', async () => {
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'demo', devDependencies: { '@nx/node': '^23.0.0' } }))

    await runAdd('node-app', 'svc', {})

    expect(mockRunNx).toHaveBeenCalledTimes(1)
    expect(mockRunNx.mock.calls[0][0][0]).toBe('g')
  })

  it('adds a package target zipping the esbuild (non-bundled) dist output into the drop', async () => {
    // The generator is mocked, so pre-create the manifest it would have written.
    mkdirSync(join(workspaceRoot, 'apps/svc'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/svc/package.json'), JSON.stringify({ name: '@demo/svc', version: '0.0.1', private: true, nx: { targets: { build: {} } } }))

    await runAdd('node-app', 'svc', {})

    // adm-zip is the packager the target runs.
    expect(mockRunShell).toHaveBeenCalledWith('npm', ['install', '--save-dev', 'adm-zip', '--no-audit', '--no-fund'], workspaceRoot)

    // node-app is inference-only (no project.json): the package target is
    // attached via the manifest's `nx` field, preserving the generator's own
    // (build/test/serve/...) targets.
    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'apps/svc/package.json'), 'utf8')) as { nx: { targets: Record<string, { executor: string, dependsOn?: string[], outputs: string[], options: { command: string } }> } }
    expect(manifest.nx.targets.build).toEqual({})
    expect(manifest.nx.targets.package).toMatchObject({
      executor:  'nx:run-commands',
      dependsOn: ['build'],
      outputs:   ['{workspaceRoot}/dist/drop/node-app-svc.zip'],
    })
    expect(manifest.nx.targets.package.options.command).toContain(`addLocalFolder('apps/svc/dist')`)
    expect(manifest.nx.targets.package.options.command).toContain(`writeZip('dist/drop/node-app-svc.zip')`)
  })

  it('passes the vitest runner from nx.json to the node generator', async () => {
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ mnci: { stack: { linter: 'eslint', testRunner: 'vitest' } } }))
    mkdirSync(join(workspaceRoot, 'apps/svc'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/svc/package.json'), JSON.stringify({ name: '@demo/svc' }))

    await runAdd('node-app', 'svc', {})

    const generatorCall = mockRunNx.mock.calls.find((call) => call[0][1] === '@nx/node:application')
    expect(generatorCall?.[0]).toContain('--unitTestRunner=vitest')
  })
})

describe('runAdd node-function-app', () => {
  it('generates via the plain application generator, then overlays the Azure Functions v4 shape', async () => {
    mkdirSync(join(workspaceRoot, 'apps/api'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/api/package.json'), JSON.stringify({ name: '@demo/api', version: '0.0.1', private: true, nx: { targets: { build: {} } }, dependencies: {} }))

    await runAdd('node-function-app', 'api', {})

    expect(mockRunNx).toHaveBeenCalledWith([
      'g', '@nx/node:application', 'apps/api',
      '--bundler=esbuild',
      '--unitTestRunner=jest',
      '--linter=eslint',
      '--e2eTestRunner=none',
      '--framework=none',
      '--no-interactive',
    ], workspaceRoot)

    // @azure/functions is installed for real (unlike the removed plugin, a
    // plain @nx/node:application app has no Azure dependency by default).
    expect(mockRunShell).toHaveBeenCalledWith('npm', ['install', '@azure/functions', '--no-audit', '--no-fund'], workspaceRoot)

    // The v4 programming model: an HTTP trigger importing a tested helper,
    // wired into the esbuild entry so it's reachable (and thus bundled).
    expect(readFileSync(join(workspaceRoot, 'apps/api/src/main.ts'), 'utf8')).toContain(`import './functions/hello'`)
    const hello = readFileSync(join(workspaceRoot, 'apps/api/src/functions/hello.ts'), 'utf8')
    expect(hello).toContain(`from '@azure/functions'`)
    expect(hello).toContain(`app.http('hello'`)
    expect(readFileSync(join(workspaceRoot, 'apps/api/src/functions/greeting.ts'), 'utf8')).toContain('export function buildGreeting')
    expect(readFileSync(join(workspaceRoot, 'apps/api/src/functions/greeting.spec.ts'), 'utf8')).toContain('buildGreeting')
    expect(readFileSync(join(workspaceRoot, 'apps/api/host.json'), 'utf8')).toContain('extensionBundle')

    // The manifest is repaired for the Azure deploy: `main` points at the
    // esbuild dist shim, and the real dependency is declared (for Oryx's
    // deploy-time npm install) — the generator's own `nx` targets survive.
    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'apps/api/package.json'), 'utf8')) as { main: string, dependencies: Record<string, string>, nx: { targets: Record<string, unknown> } }
    expect(manifest.main).toBe('main.js')
    expect(manifest.dependencies['@azure/functions']).toBe('^4.16.2')
    expect(manifest.nx.targets.build).toEqual({})

    // Package target zips the dist output together with host.json and the
    // repaired manifest — no node_modules bundled (Oryx installs at deploy).
    expect(manifest.nx.targets.package).toMatchObject({
      executor:  'nx:run-commands',
      dependsOn: ['build'],
      outputs:   ['{workspaceRoot}/dist/drop/node-function-app-api.zip'],
    })
    const packageCommand = (manifest.nx.targets.package as { options: { command: string } }).options.command
    expect(packageCommand).toContain(`addLocalFolder('apps/api/dist')`)
    expect(packageCommand).toContain(`addLocalFile('apps/api/host.json')`)
    expect(packageCommand).toContain(`addLocalFile('apps/api/package.json')`)
    expect(packageCommand).toContain(`writeZip('dist/drop/node-function-app-api.zip')`)
  })

  it('skips the @azure/functions install when it is already a dependency', async () => {
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { '@azure/functions': '^4.0.0' } }))
    mkdirSync(join(workspaceRoot, 'apps/api'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/api/package.json'), JSON.stringify({ name: '@demo/api', dependencies: {} }))

    await runAdd('node-function-app', 'api', {})

    expect(mockRunShell).not.toHaveBeenCalledWith('npm', ['install', '@azure/functions', '--no-audit', '--no-fund'], workspaceRoot)
  })
})
