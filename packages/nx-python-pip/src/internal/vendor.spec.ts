import { addPackagesToWheelTarget, parseVendorEntries } from './vendor'

describe('parseVendorEntries', () => {
  it('extracts project names from a [tool.mnci-python-pip] vendor table', () => {
    const pyproject = '[project]\nname = "pyshared"\n\n[tool.mnci-python-pip]\nvendor = ["pycore", "other-lib"]\n'
    expect(parseVendorEntries(pyproject)).toEqual(['pycore', 'other-lib'])
  })

  it('returns an empty array when there is no vendor table', () => {
    expect(parseVendorEntries('[project]\nname = "pysvc"\ndependencies = []\n')).toEqual([])
  })

  it('returns an empty array for an explicitly empty vendor list', () => {
    expect(parseVendorEntries('vendor = []\n')).toEqual([])
  })
})

describe('addPackagesToWheelTarget', () => {
  it('appends vendored module directories to the wheel packages list', () => {
    const pyproject = '[tool.hatch.build.targets.wheel]\npackages = ["pyshared"]\n'
    const patched = addPackagesToWheelTarget(pyproject, ['pycore'])
    expect(patched).toContain('packages = ["pyshared", "pycore"]')
  })

  it('de-duplicates when a module is already present', () => {
    const pyproject = 'packages = ["pyshared", "pycore"]\n'
    expect(addPackagesToWheelTarget(pyproject, ['pycore'])).toContain('packages = ["pyshared", "pycore"]')
  })

  it('leaves the content unchanged when no packages list is found', () => {
    const pyproject = '[project]\nname = "pysvc"\n'
    expect(addPackagesToWheelTarget(pyproject, ['pycore'])).toBe(pyproject)
  })
})
