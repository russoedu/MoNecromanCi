import { pythonModuleDirectory, pythonPyprojectToml, pythonSampleModule, pythonSampleTest } from './pythonProject'

describe('pythonModuleDirectory', () => {
  it('replaces hyphens with underscores', () => {
    expect(pythonModuleDirectory('my-svc')).toBe('my_svc')
  })

  it('leaves a name with no hyphens unchanged', () => {
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
