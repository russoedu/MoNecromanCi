// `resolvedVersion` shells out for pip only; mocked so the suite needs no
// interpreter and the pip branch is driven through the stub's stdout.
jest.mock('../nx', () => ({ runCapture: jest.fn(() => ({ status: 1, stdout: '' })) }))

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCapture } from '../nx'
import {
  ROOT_LABEL,
  collectInventory,
  hasEcosystem,
  parseRequirement,
  pubspecBlockEntries,
  pyprojectDependencies,
  replacePipSpec,
  replacePubSpec,
  resolvedVersion,
  rewriteSpec,
  type DependencySite
} from './inventory'

const mockRunCapture = jest.mocked(runCapture)

let workspaceRoot: string

/**
 * Writes a file, creating its directory first.
 *
 * @param relativePath - Path relative to the temp workspace root.
 * @param content - The file content.
 * @returns The absolute path written.
 */
function write (relativePath: string, content: string): string {
  const path = join(workspaceRoot, relativePath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

/**
 * Finds one declaration of a package, by project.
 *
 * @param sites - Every declaration of that package.
 * @param project - The project label to look for.
 * @returns The matching site.
 */
function siteIn (sites: DependencySite[] | undefined, project: string): DependencySite {
  const site = sites?.find(entry => entry.project === project)
  if (!site) {
    throw new Error(`no declaration in ${project}`)
  }
  return site
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'mnci-inventory-'))
  mockRunCapture.mockReturnValue({ status: 1, stdout: '' })
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  jest.restoreAllMocks()
})

describe('npm', () => {
  it('reads the root manifest and every project manifest', () => {
    write('package.json', JSON.stringify({ devDependencies: { eslint: '^10.8.1' } }))
    write('packages/auth/package.json', JSON.stringify({ dependencies: { axios: '^1.7.2' } }))
    write('libs/core/package.json', JSON.stringify({ dependencies: { axios: '^1.9.0' } }))

    const inventory = collectInventory(workspaceRoot, ['npm'])

    expect(siteIn(inventory.get('eslint'), ROOT_LABEL).section).toBe('devDep')
    const projects = inventory.get('axios')?.map(site => site.project)
    expect(projects?.toSorted((left, right) => left.localeCompare(right))).toEqual([
      'libs/core',
      'packages/auth'
    ])
  })

  it('labels the project by directory, with forward slashes on every platform', () => {
    // globSync returns backslashes on Windows, and the project label is both a
    // display string and a key — a backslash makes one project read as two.
    write('packages/auth/package.json', JSON.stringify({ dependencies: { axios: '^1.7.2' } }))

    const site = siteIn(collectInventory(workspaceRoot, ['npm']).get('axios'), 'packages/auth')
    expect(site.project).not.toContain('\\')
  })

  it('marks a non-version spec as reportable but not rewritable', () => {
    write(
      'package.json',
      JSON.stringify({
        devDependencies: {
          // The exact shape mnci's own root manifest uses for the dual compiler.
          typescript: 'npm:@typescript/typescript6@^6.0.2',
          local: 'file:../thing',
          eslint: '^10.8.1'
        }
      })
    )

    const inventory = collectInventory(workspaceRoot, ['npm'])
    expect(siteIn(inventory.get('typescript'), ROOT_LABEL).rewritable).toBe(false)
    expect(siteIn(inventory.get('local'), ROOT_LABEL).rewritable).toBe(false)
    expect(siteIn(inventory.get('eslint'), ROOT_LABEL).rewritable).toBe(true)
  })

  it('never marks a peer range rewritable', () => {
    // A peer range is a compatibility declaration, not a version choice.
    // `@mnci/nx-python-pip` peers `@nx/devkit` at `>=21.0.0` so it loads on Nx
    // 21, 22 and 23; rewriting that to the 23.x this repo resolves would drop
    // two majors of consumers. Found by running `mnci sync --check` here.
    write(
      'packages/plugin/package.json',
      JSON.stringify({ peerDependencies: { '@nx/devkit': '>=21.0.0' } })
    )

    const site = siteIn(collectInventory(workspaceRoot, ['npm']).get('@nx/devkit'), 'packages/plugin')
    expect(site.section).toBe('peerDep')
    // Reportable — it still shows in `mnci up`'s projects column — but never written.
    expect(site.rewritable).toBe(false)
    expect(rewriteSpec(site, '^23.1.1')).toBe(false)
  })

  it('skips a malformed manifest instead of failing the whole scan', () => {
    write('package.json', '{ not json')
    write('packages/auth/package.json', JSON.stringify({ dependencies: { axios: '^1.7.2' } }))

    expect(collectInventory(workspaceRoot, ['npm']).get('axios')).toHaveLength(1)
  })
})

describe('pip', () => {
  it('reads pyproject dependencies, requirements-dev and an app requirements file', () => {
    write(
      'python-packages/shared/pyproject.toml',
      '[project]\nname = "shared"\ndependencies = ["requests>=2.31.0"]\n'
    )
    write('requirements-dev.txt', 'build\nruff\n')
    write('apps/fn/requirements.txt', 'azure-functions\nrequests==2.30.0\n')

    const inventory = collectInventory(workspaceRoot, ['pip'])

    expect(siteIn(inventory.get('requests'), 'python-packages/shared').spec).toBe('>=2.31.0')
    expect(siteIn(inventory.get('requests'), 'apps/fn').spec).toBe('==2.30.0')
    // The root file is the shared toolchain — that is what it is FOR.
    expect(siteIn(inventory.get('ruff'), ROOT_LABEL).section).toBe('devDep')
  })

  it('reads dependencies only from the [project] table', () => {
    // A build backend or tool section can carry its own `dependencies` key; a
    // whole-file scan would report those as runtime requirements.
    const content = [
      '[project]',
      'name = "app"',
      'dependencies = ["requests>=2.31.0"]',
      '',
      '[tool.something]',
      'dependencies = ["never-a-runtime-dep"]',
      ''
    ].join('\n')

    expect(pyprojectDependencies(content)).toEqual(['requests>=2.31.0'])
  })

  it('reads a multi-line dependencies array', () => {
    const content = ['[project]', 'dependencies = [', '  "a>=1",', '  "b==2"', ']', ''].join('\n')
    expect(pyprojectDependencies(content)).toEqual(['a>=1', 'b==2'])
  })
})

describe('parseRequirement', () => {
  it('splits a name from its version spec', () => {
    expect(parseRequirement('requests>=2.31.0')).toEqual({
      name: 'requests',
      spec: '>=2.31.0',
      rewritable: true
    })
  })

  it('ignores comments and pip flags', () => {
    expect(parseRequirement('  # a comment')).toBeUndefined()
    expect(parseRequirement('-r other.txt')).toBeUndefined()
    expect(parseRequirement('requests>=2.31.0  # pinned')?.spec).toBe('>=2.31.0')
  })

  it('reports but refuses to rewrite extras, markers and compound ranges', () => {
    expect(parseRequirement('requests[socks]>=2')?.rewritable).toBe(false)
    expect(parseRequirement('requests>=2; python_version < "3.11"')?.rewritable).toBe(false)
    expect(parseRequirement('requests>=2,<3')?.rewritable).toBe(false)
  })

  it('stays linear on a long pathological line', () => {
    // The regex this replaced was flagged for polynomial backtracking; a naive
    // pattern takes seconds on input like this.
    const start = Date.now()
    parseRequirement(`a${'-'.repeat(20_000)} `)
    expect(Date.now() - start).toBeLessThan(1000)
  })
})

describe('pub', () => {
  it('reads a member pubspec, and never the root one', () => {
    // The root pubspec of a pub workspace carries the member list and an SDK
    // floor — no dependency blocks at all. Reading it would invent a conflict.
    write('pubspec.yaml', 'name: demo\npublish_to: none\n\nworkspace:\n  - apps/ui\n')
    write(
      'apps/ui/pubspec.yaml',
      ['name: ui', 'dependencies:', '  http: ^1.2.0', '  flutter:', '    sdk: flutter', ''].join(
        '\n'
      )
    )

    const inventory = collectInventory(workspaceRoot, ['pub'])
    expect(siteIn(inventory.get('http'), 'apps/ui').spec).toBe('^1.2.0')
    expect(inventory.get('demo')).toBeUndefined()
  })

  it('reports a nested-map dependency but marks it unrewritable', () => {
    const content = [
      'dependencies:',
      '  http: ^1.2.0',
      '  flutter:',
      '    sdk: flutter',
      '  other:',
      '    git:',
      '      url: https://example.test/a.git',
      ''
    ].join('\n')

    const entries = pubspecBlockEntries(content, 'dependencies')
    expect(entries).toEqual([
      { name: 'http', spec: '^1.2.0' },
      { name: 'flutter', spec: '' },
      { name: 'other', spec: '' }
    ])
  })

  it('handles CRLF, which is what flutter create writes on Windows', () => {
    // A pattern that assumed LF is exactly how the Flutter internal-dependency
    // injection silently did nothing for months.
    const content = 'dependencies:\r\n  http: ^1.2.0\r\n'
    expect(pubspecBlockEntries(content, 'dependencies')).toEqual([
      { name: 'http', spec: '^1.2.0' }
    ])
  })
})

describe('go', () => {
  it('reads the root go.mod and labels indirect requirements', () => {
    write(
      'go.mod',
      [
        'module github.com/demo/repo',
        '',
        'go 1.23',
        '',
        'require (',
        '\tgithub.com/spf13/cobra v1.8.0',
        '\tgithub.com/inconshreveable/mousetrap v1.1.0 // indirect',
        ')',
        ''
      ].join('\n')
    )

    const inventory = collectInventory(workspaceRoot, ['go'])
    expect(inventory.get('github.com/spf13/cobra')?.[0].section).toBe('module')
    expect(inventory.get('github.com/inconshreveable/mousetrap')?.[0].section).toBe('indirect')
    // go.mod is the toolchain's file — `go get` writes it, never this code.
    expect(inventory.get('github.com/spf13/cobra')?.[0].rewritable).toBe(false)
  })
})

describe('hasEcosystem', () => {
  it('detects each ecosystem by its root marker', () => {
    expect(hasEcosystem(workspaceRoot, 'go')).toBe(false)
    expect(hasEcosystem(workspaceRoot, 'pub')).toBe(false)
    expect(hasEcosystem(workspaceRoot, 'pip')).toBe(false)

    write('go.mod', 'module x\n')
    write('pubspec.yaml', 'name: x\n')
    write('requirements-dev.txt', 'ruff\n')

    expect(hasEcosystem(workspaceRoot, 'go')).toBe(true)
    expect(hasEcosystem(workspaceRoot, 'pub')).toBe(true)
    expect(hasEcosystem(workspaceRoot, 'pip')).toBe(true)
  })

  it('detects pip from a project pyproject even with no root requirements file', () => {
    write('libs/shared/pyproject.toml', '[project]\nname = "shared"\n')
    expect(hasEcosystem(workspaceRoot, 'pip')).toBe(true)
  })
})

describe('rewriteSpec', () => {
  it('rewrites an npm manifest entry and leaves its siblings alone', () => {
    const path = write(
      'packages/auth/package.json',
      JSON.stringify({ name: 'auth', dependencies: { axios: '^1.7.2', zod: '^3.0.0' } }, undefined, 2)
    )
    const site = siteIn(collectInventory(workspaceRoot, ['npm']).get('axios'), 'packages/auth')

    expect(rewriteSpec(site, '^1.9.0')).toBe(true)

    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      name: string
      dependencies: Record<string, string>
    }
    expect(manifest.dependencies).toEqual({ axios: '^1.9.0', zod: '^3.0.0' })
    expect(manifest.name).toBe('auth')
  })

  it('refuses a site it marked unrewritable', () => {
    write('package.json', JSON.stringify({ devDependencies: { typescript: 'npm:other@^6.0.0' } }))
    const site = siteIn(collectInventory(workspaceRoot, ['npm']).get('typescript'), ROOT_LABEL)

    expect(rewriteSpec(site, '^7.0.0')).toBe(false)
  })

  it('preserves comments and formatting when rewriting a pyproject', () => {
    // The whole reason the text formats are edited in place rather than
    // round-tripped through a serialiser.
    const path = write(
      'libs/shared/pyproject.toml',
      [
        '# Generated by MoNecromanCI.',
        '[project]',
        'name = "shared"',
        'dependencies = ["requests>=2.31.0"]  # pinned deliberately',
        ''
      ].join('\n')
    )
    const site = siteIn(collectInventory(workspaceRoot, ['pip']).get('requests'), 'libs/shared')

    expect(rewriteSpec(site, '>=2.32.0')).toBe(true)

    const content = readFileSync(path, 'utf8')
    expect(content).toContain('# Generated by MoNecromanCI.')
    expect(content).toContain('# pinned deliberately')
    expect(content).toContain('"requests>=2.32.0"')
  })

  it('rewrites a pubspec constraint without touching a nested map', () => {
    const path = write(
      'apps/ui/pubspec.yaml',
      ['name: ui', '', 'dependencies:', '  http: ^1.2.0', '  flutter:', '    sdk: flutter', ''].join(
        '\n'
      )
    )
    const site = siteIn(collectInventory(workspaceRoot, ['pub']).get('http'), 'apps/ui')

    expect(rewriteSpec(site, '^1.3.0')).toBe(true)

    const content = readFileSync(path, 'utf8')
    expect(content).toContain('  http: ^1.3.0')
    expect(content).toContain('  flutter:\n    sdk: flutter')
  })
})

describe('replacePipSpec', () => {
  it('does not touch a package whose name merely starts the same', () => {
    // `pytest` vs `pytest-cov`: the boundary is the whole point.
    const before = 'pytest>=7\npytest-cov>=4\n'
    expect(replacePipSpec(before, 'pytest', '>=8')).toBe('pytest>=8\npytest-cov>=4\n')
  })

  it('escapes a name containing regex metacharacters', () => {
    const before = '"ruamel.yaml>=0.17"\n'
    expect(replacePipSpec(before, 'ruamel.yaml', '>=0.18')).toBe('"ruamel.yaml>=0.18"\n')
  })
})

describe('replacePubSpec', () => {
  it('leaves a key that introduces a nested map alone', () => {
    const before = 'dependencies:\n  flutter:\n    sdk: flutter\n'
    expect(replacePubSpec(before, 'flutter', '^1.0.0')).toBe(before)
  })
})

describe('resolvedVersion', () => {
  it('reads npm from node_modules', () => {
    write('node_modules/axios/package.json', JSON.stringify({ version: '1.8.4' }))
    expect(resolvedVersion(workspaceRoot, 'npm', 'axios')).toBe('1.8.4')
  })

  it('reads pub from the single root lockfile', () => {
    write(
      'pubspec.lock',
      [
        'packages:',
        '  http:',
        '    dependency: "direct main"',
        '    source: hosted',
        '    version: "1.2.2"',
        '  meta:',
        '    version: "1.16.0"',
        ''
      ].join('\n')
    )
    expect(resolvedVersion(workspaceRoot, 'pub', 'http')).toBe('1.2.2')
    expect(resolvedVersion(workspaceRoot, 'pub', 'meta')).toBe('1.16.0')
  })

  it('reads pip from the interpreter', () => {
    mockRunCapture.mockReturnValue({ status: 0, stdout: 'Name: requests\nVersion: 2.32.3\n' })
    expect(resolvedVersion(workspaceRoot, 'pip', 'requests')).toBe('2.32.3')
  })

  it('returns undefined rather than throwing when nothing is installed', () => {
    expect(resolvedVersion(workspaceRoot, 'npm', 'axios')).toBeUndefined()
    expect(resolvedVersion(workspaceRoot, 'pub', 'http')).toBeUndefined()
    expect(resolvedVersion(workspaceRoot, 'pip', 'requests')).toBeUndefined()
    // Go's root go.mod IS the resolved state — there is nothing else to read.
    expect(resolvedVersion(workspaceRoot, 'go', 'github.com/spf13/cobra')).toBeUndefined()
  })
})
