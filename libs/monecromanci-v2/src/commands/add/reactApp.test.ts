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
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci2-add-react-app-'))
  mockRunShell.mockImplementation(() => 0)
  jest.spyOn(process, 'cwd').mockReturnValue(workspaceRoot)
  jest.spyOn(console, 'log').mockImplementation(() => {})
  writeFileSync(join(workspaceRoot, 'nx.json'), '{}')
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: '@demo/source', devDependencies: {} }))
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

describe('runAdd react-app', () => {
  it('installs @nx/react on first use, then delegates to the app generator', async () => {
    await runAdd('react-app', 'web', {})

    expect(mockRunNx).toHaveBeenNthCalledWith(1, ['add', '@nx/react'], workspaceRoot)
    expect(mockRunNx).toHaveBeenNthCalledWith(2, [
      'g', '@nx/react:app', 'apps/web',
      '--bundler=vite',
      '--unitTestRunner=jest',
      '--linter=eslint',
      '--style=css',
      '--e2eTestRunner=none',
      '--no-interactive',
    ], workspaceRoot)
  })

  it('skips the plugin install when it is already a devDependency', async () => {
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'demo', devDependencies: { '@nx/react': '^23.0.0' } }))

    await runAdd('react-app', 'web', {})

    expect(mockRunNx).toHaveBeenCalledTimes(1)
    expect(mockRunNx.mock.calls[0][0][0]).toBe('g')
  })

  it('builds a react app per environment (dev/uat/prod), each into its own drop zip', async () => {
    // The generator is mocked, so pre-create the manifest it would have written.
    mkdirSync(join(workspaceRoot, 'apps/web'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/web/package.json'), JSON.stringify({ name: '@demo/web', version: '0.0.1', private: true }))

    await runAdd('react-app', 'web', {})

    // adm-zip is the packager the target runs.
    expect(mockRunShell).toHaveBeenCalledWith('npm', ['install', '--save-dev', 'adm-zip', '--no-audit', '--no-fund'], workspaceRoot)

    // A .env.<env> is scaffolded per environment (public VITE_ config).
    for (const environment of ['dev', 'uat', 'prod']) {
      expect(readFileSync(join(workspaceRoot, `apps/web/.env.${environment}`), 'utf8')).toContain(`VITE_ENVIRONMENT=${environment}`)
    }

    // React apps are inference-only (no project.json): targets are attached via
    // the manifest's `nx` field, preserving the existing manifest.
    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'apps/web/package.json'), 'utf8')) as { name: string, nx: { targets: Record<string, { executor: string, dependsOn?: string[], outputs: string[], options: { command: string, cwd?: string } }> } }
    expect(manifest.name).toBe('@demo/web')
    const targets = manifest.nx.targets

    // One build target per environment: vite build --mode <env> --outDir dist-<env>.
    for (const environment of ['dev', 'uat', 'prod']) {
      expect(targets[`build-${environment}`]).toMatchObject({ executor: 'nx:run-commands', options: { command: `vite build --mode ${environment} --outDir dist-${environment}`, cwd: 'apps/web' } })
    }

    // The package target depends on the three env builds and emits one zip per
    // environment — the exact names CI turns into per-env build tags.
    expect(targets.package.dependsOn).toEqual(['build-dev', 'build-uat', 'build-prod'])
    expect(targets.package.outputs).toEqual([
      '{workspaceRoot}/dist/drop/react-app-web-dev.zip',
      '{workspaceRoot}/dist/drop/react-app-web-uat.zip',
      '{workspaceRoot}/dist/drop/react-app-web-prod.zip',
    ])
    expect(targets.package.options.command).toContain(`writeZip('dist/drop/react-app-web-uat.zip')`)
  })

  it('passes the vitest runner from nx.json to the react generator', async () => {
    writeFileSync(join(workspaceRoot, 'nx.json'), JSON.stringify({ mnci2: { stack: { linter: 'eslint', testRunner: 'vitest' } } }))
    mkdirSync(join(workspaceRoot, 'apps/web'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'apps/web/package.json'), JSON.stringify({ name: '@demo/web' }))

    await runAdd('react-app', 'web', {})

    const generatorCall = mockRunNx.mock.calls.find((call) => call[0][1] === '@nx/react:app')
    expect(generatorCall?.[0]).toContain('--unitTestRunner=vitest')
  })
})
