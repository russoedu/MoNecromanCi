import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import type { CreateDependenciesContext } from '@nx/devkit'
import { createDependencies } from './python-dependencies.handler'

/*
 * These run against a REAL directory tree, because the handler reads
 * `pyproject.toml` from disk through `node:fs` - that is what Nx gives a
 * `createDependencies` hook, which receives project roots rather than file
 * contents. Mocking `readFileSync` would test the mock's shape instead of the
 * behaviour, which is the failure mode this repo keeps rediscovering.
 */

let workspace: string

/** Writes a project directory, with a `pyproject.toml` when one is given. */
function project (name: string, pyproject?: string): void {
  mkdirSync(join(workspace, name), { recursive: true })
  if (pyproject !== undefined) {
    writeFileSync(join(workspace, name, 'pyproject.toml'), pyproject)
  }
}

/**
 * The subset of `CreateDependenciesContext` the handler reads, plus the file
 * map `validateDependency` needs.
 *
 * @remarks
 * The `projectFileMap` is not decoration: Nx's validator resolves a
 * dependency's `sourceFile` against it and rejects a path it cannot find. That
 * check is what caught this handler emitting a backslashed path on Windows, so
 * the spec supplies a realistic map rather than an empty one - an empty map
 * would have disabled the validation the handler relies on.
 */
function context (...names: string[]): CreateDependenciesContext {
  const projectFileMap = Object.fromEntries(
    names.map(name => [name, [{ file: posix.join(name, 'pyproject.toml'), hash: 'h' }]]),
  )

  return {
    workspaceRoot:       workspace,
    projects:            Object.fromEntries(names.map(name => [name, { root: name }])),
    externalNodes:       {},
    fileMap:             { projectFileMap, nonProjectFiles: [] },
    filesToProcess:      { projectFileMap, nonProjectFiles: [] },
    nxJsonConfiguration: {},
  }
}

/** A manifest with the given distribution name and dependency entries. */
const manifest = (name: string, dependencies = '', extra = '') => `[project]
name = "${name}"
version = "0.23.0"
dependencies = [${dependencies}]
${extra}`

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mnci-python-graph-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('createDependencies', () => {
  it('adds an edge for a registry dependency on a workspace project', () => {
    project('ink', manifest('scanmate-ink'))
    project('scan', manifest('scanmate-scan', '"scanmate-ink>=0.23.0"'))

    expect(createDependencies({}, context('ink', 'scan'))).toEqual([
      { source: 'scan', target: 'ink', type: 'static', sourceFile: 'scan/pyproject.toml' },
    ])
  })

  it('matches a dependency spelled differently from the project it names', () => {
    /*
     * PEP 503: `scanmate_ink` and `scanmate-ink` are the same distribution.
     * Comparing the raw strings would drop this edge silently, and a graph
     * with a missing edge looks exactly like a graph with nothing to say.
     */
    project('ink', manifest('scanmate-ink'))
    project('scan', manifest('scanmate-scan', '"scanmate_ink >= 0.23.0"'))

    expect(createDependencies({}, context('ink', 'scan'))).toHaveLength(1)
  })

  it('adds an edge for a vendored internal library', () => {
    /*
     * The strongest edge there is: the build executor copies the vendored
     * module INTO the dependant's wheel, so a change there changes the
     * artefact. A vendor entry names the Nx project, not a distribution.
     */
    project('core', manifest('pycore'))
    project(
      'shared',
      manifest('pyshared', '', '\n[tool.mnci-python-pip]\nvendor = ["core"]\n'),
    )

    expect(createDependencies({}, context('core', 'shared'))).toEqual([
      {
        source:     'shared',
        target:     'core',
        type:       'static',
        sourceFile: 'shared/pyproject.toml',
      },
    ])
  })

  it('never reports the same edge twice when a project both declares and vendors it', () => {
    project('ink', manifest('scanmate-ink'))
    project(
      'scan',
      manifest('scanmate-scan', '"scanmate-ink>=0.23.0"', '\n[tool.mnci-python-pip]\nvendor = ["ink"]\n'),
    )

    expect(createDependencies({}, context('ink', 'scan'))).toHaveLength(1)
  })

  it('ignores an external dependency that matches no workspace project', () => {
    project('scan', manifest('scanmate-scan', '"numpy>=2", "pillow"'))

    expect(createDependencies({}, context('scan'))).toEqual([])
  })

  it('ignores a project with no pyproject.toml', () => {
    // The normal case in a mixed workspace, and the shape of a Python FUNCTION
    // app, which carries only a requirements.txt.
    project('web')
    project('scan', manifest('scanmate-scan'))

    expect(createDependencies({}, context('web', 'scan'))).toEqual([])
  })

  it('does not add a self-edge when a project names its own distribution', () => {
    project('ink', manifest('scanmate-ink', '"scanmate-ink>=0.1"'))

    expect(createDependencies({}, context('ink'))).toEqual([])
  })

  it('reports each edge of a chain separately', () => {
    project('ink', manifest('scanmate-ink'))
    project('scan', manifest('scanmate-scan', '"scanmate-ink>=0.23.0"'))
    project('ocr', manifest('scanmate-ocr', '"scanmate-scan>=0.23.0"'))

    const edges = createDependencies({}, context('ink', 'scan', 'ocr'))

    expect(edges).toHaveLength(2)
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'scan', target: 'ink' }),
        expect.objectContaining({ source: 'ocr', target: 'scan' }),
      ]),
    )
  })
})
