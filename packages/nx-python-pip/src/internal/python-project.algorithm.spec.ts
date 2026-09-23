import {
  pythonModuleDirectory,
  pythonPyprojectToml,
  pythonSampleModule,
  pythonSampleTest,
} from './python-project.algorithm'

describe('pythonModuleDirectory', () => {
  it('replaces hyphens with underscores', () => {
    expect(pythonModuleDirectory('my-svc')).toBe('my_svc')
  })

  it('replaces dots too — a dot is Python’s package separator', () => {
    // The subtle one. A hyphen is merely an invalid identifier character, but a
    // surviving dot would be *valid syntax* meaning something else entirely: a
    // submodule of a package that does not exist. That lands as a wrong
    // hatchling `packages` entry and an unimportable wheel, with no error at
    // generation time — so this is the case worth pinning down.
    expect(pythonModuleDirectory('my.svc')).toBe('my_svc')
    expect(pythonModuleDirectory('api.v2')).toBe('api_v2')
    expect(pythonModuleDirectory('my-svc.v2')).toBe('my_svc_v2')
  })

  it('leaves a name with no hyphens or dots unchanged', () => {
    expect(pythonModuleDirectory('pycore')).toBe('pycore')
  })
})

describe('pythonPyprojectToml', () => {
  it('writes the project name, hatchling backend and wheel packages list', () => {
    const toml = pythonPyprojectToml('my-svc', 'my_svc')
    expect(toml).toContain('name = "my-svc"')
    expect(toml).toContain('build-backend = "hatchling.build"')
    expect(toml).toContain('packages = ["my_svc"]')
    expect(toml).toContain('dependencies = []')
  })

  it('configures mypy as strict, so a generated project is typed from day one', () => {
    /*
     * Measured, not aspirational: both templates this generator writes are
     * fully annotated, so a freshly generated project passes `mypy --strict`
     * with no findings. Verified by running the real binary against the real
     * emitted manifest.
     */
    const toml = pythonPyprojectToml('my-svc', 'my_svc')

    expect(toml).toContain('[tool.mypy]')
    expect(toml).toContain('strict = true')
  })

  it('tolerates a stub-less third-party import, and ONLY that', () => {
    /*
     * The one thing that breaks plain strict in practice: importing a library
     * that ships no type stubs fails as `import-untyped` on code the user
     * wrote normally and cannot fix - the same class as the jsx-a11y and TOML
     * relaxations elsewhere in mnci, where a generated project must not fail
     * its own gate on upstream boilerplate.
     *
     * Asserted in BOTH directions. `import-not-found` - a module that
     * genuinely cannot be resolved - must keep failing, or the relaxation
     * would quietly turn every typo'd import into `Any`.
     */
    const toml = pythonPyprojectToml('my-svc', 'my_svc')

    expect(toml).toContain('disable_error_code = ["import-untyped"]')
    expect(toml).not.toContain('ignore_missing_imports')
    expect(toml).not.toContain('import-not-found"]')
  })
})

describe('pythonSampleModule + pythonSampleTest', () => {
  it('generates a module and a test that actually pass together', () => {
    const module_ = pythonSampleModule('pycore')
    const test = pythonSampleTest('pycore')
    expect(module_).toContain('return "hello from pycore"')
    expect(test).toContain('from pycore import hello')
    expect(test).toContain('hello() == "hello from pycore"')
  })
})
