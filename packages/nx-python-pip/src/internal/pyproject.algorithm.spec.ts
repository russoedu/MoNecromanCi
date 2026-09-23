import {
  normaliseDistributionName,
  pyprojectDependencies,
  pyprojectName,
  requirementName,
  requirementSpecifier,
  rewriteRequirementVersion,
  withRewrittenDependency,
} from './pyproject.algorithm'

/** A manifest of the shape this plugin's own generator writes. */
const manifest = (dependencies: string) => `[project]
name = "scanmate-scan"
version = "0.23.0"
description = ""
requires-python = ">=3.9"
dependencies = [${dependencies}]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["scanmate_scan"]
`

describe('pyprojectName', () => {
  it('reads the name from the [project] table', () => {
    expect(pyprojectName(manifest(''))).toBe('scanmate-scan')
  })

  it('ignores a name declared under another table', () => {
    /*
     * The reason this is scoped rather than a whole-file match: a tool table
     * naming itself first would otherwise be returned as the distribution.
     */
    const content = '[tool.poetry]\nname = "not-this-one"\n\n[project]\nname = "real"\n'
    expect(pyprojectName(content)).toBe('real')
  })

  it('returns undefined when there is no [project] name', () => {
    expect(pyprojectName('[build-system]\nrequires = ["hatchling"]\n')).toBeUndefined()
  })
})

describe('pyprojectDependencies', () => {
  it('reads a single-line array', () => {
    expect(pyprojectDependencies(manifest('"numpy>=2", "scanmate-ink>=0.23.0"'))).toEqual([
      'numpy>=2',
      'scanmate-ink>=0.23.0',
    ])
  })

  it('reads a multi-line array', () => {
    const content = manifest('\n  "numpy>=2",\n  "scanmate-ink>=0.23.0",\n')
    expect(pyprojectDependencies(content)).toEqual(['numpy>=2', 'scanmate-ink>=0.23.0'])
  })

  it('ignores a dependencies key under another table', () => {
    /*
     * `[build-system] requires` is not the only trap - a tool table can declare
     * `dependencies` too, and sweeping those in would invent runtime
     * requirements the project does not have.
     */
    const content =
      '[project]\nname = "a"\ndependencies = ["real-dep"]\n\n[tool.other]\ndependencies = ["not-a-dep"]\n'
    expect(pyprojectDependencies(content)).toEqual(['real-dep'])
  })

  it('returns an empty list for the generator default', () => {
    expect(pyprojectDependencies(manifest(''))).toEqual([])
  })

  it('stays linear on a pathological line', () => {
    // The regexes read user-authored text, so a manifest with one enormous
    // entry must not hang the project graph.
    const started = Date.now()
    pyprojectDependencies(manifest(`"${'a'.repeat(20_000)}"`))
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('normaliseDistributionName', () => {
  it.each([
    ['scanmate-ink', 'scanmate-ink'],
    ['scanmate_ink', 'scanmate-ink'],
    ['Scanmate.Ink', 'scanmate-ink'],
    ['scanmate__ink', 'scanmate-ink'],
    ['SCANMATE-.-INK', 'scanmate-ink'],
  ])('normalises %s to %s', (input, expected) => {
    // PEP 503: all five of these are the SAME distribution to pip. Comparing
    // the raw strings is how a graph edge goes missing with nothing reporting
    // it.
    expect(normaliseDistributionName(input)).toBe(expected)
  })
})

describe('requirementName and requirementSpecifier', () => {
  it.each([
    ['scanmate-ink>=0.23.0', 'scanmate-ink', '>=0.23.0'],
    ['numpy == 2.1', 'numpy', '== 2.1'],
    ['pillow', 'pillow', ''],
    ['pikepdf[extra]>=10', 'pikepdf', '[extra]>=10'],
    ['cryptography>=50; python_version >= "3.11"', 'cryptography', '>=50; python_version >= "3.11"'],
  ])('splits %s', (requirement, name, specifier) => {
    expect(requirementName(requirement)).toBe(name)
    expect(requirementSpecifier(requirement)).toBe(specifier)
  })

  it.each([['', 'empty'], [' '.repeat(3), 'blank'], ['-e .', 'a flag'], ['# a note', 'a comment']])(
    'returns undefined for %s (%s)',
    (requirement) => {
      expect(requirementName(requirement)).toBeUndefined()
    },
  )
})

describe('rewriteRequirementVersion', () => {
  it.each([
    ['scanmate-ink>=0.23.0', 'scanmate-ink>=0.24.0'],
    ['scanmate-ink==0.23.0', 'scanmate-ink==0.24.0'],
    ['scanmate-ink~=0.23.0', 'scanmate-ink~=0.24.0'],
    ['scanmate-ink===0.23.0', 'scanmate-ink===0.24.0'],
    ['scanmate-ink > 0.23.0', 'scanmate-ink>0.24.0'],
  ])('keeps the operator of %s', (requirement, expected) => {
    /*
     * The operator is the meaning. A workspace declaring `>=0.23.0` is stating
     * a floor; rewriting it to `==0.24.0` would change what the dependency
     * means while looking like a version bump.
     */
    expect(rewriteRequirementVersion(requirement, '0.24.0')).toBe(expected)
  })

  it.each([
    ['scanmate-ink', 'unpinned - a deliberate "any version", not a stale one'],
    ['scanmate-ink>=0.23.0,<1', 'a compound range - which bound is being bumped is unknowable'],
    ['scanmate-ink[extra]>=0.23.0', 'extras'],
    ['scanmate-ink>=0.23.0; python_version >= "3.11"', 'an environment marker'],
    ['scanmate-ink @ https://example.invalid/ink.whl', 'a direct URL, which names no version'],
    ['# not a requirement', 'not a requirement at all'],
  ])('refuses %s (%s)', (requirement) => {
    // Refusing is reported by the caller, never silently skipped: a dependant
    // whose specifier could not move is exactly the under-bump to catch.
    expect(rewriteRequirementVersion(requirement, '0.24.0')).toBeUndefined()
  })
})

describe('withRewrittenDependency', () => {
  it('rewrites the entry and leaves the rest of the file byte-identical', () => {
    const content = manifest('\n  "numpy>=2",\n  "scanmate-ink>=0.23.0",\n')
    const result = withRewrittenDependency(content, 'scanmate-ink', '0.24.0')

    expect(result).toEqual({
      content: expect.stringContaining('"scanmate-ink>=0.24.0"'),
      from:    'scanmate-ink>=0.23.0',
      to:      'scanmate-ink>=0.24.0',
    })
    // Comments, ordering and every other entry survive: this edits the text
    // rather than parsing and re-emitting TOML.
    expect(result?.content).toContain('"numpy>=2"')
    expect(result?.content.replace('0.24.0', '0.23.0')).toBe(content)
  })

  it('matches a differently spelled distribution name', () => {
    const content = manifest('"scanmate_ink>=0.23.0"')
    expect(withRewrittenDependency(content, 'scanmate-ink', '0.24.0')?.to).toBe(
      'scanmate_ink>=0.24.0',
    )
  })

  it('preserves single quotes', () => {
    const content = manifest("'scanmate-ink>=0.23.0'")
    expect(withRewrittenDependency(content, 'scanmate-ink', '0.24.0')?.content).toContain(
      "'scanmate-ink>=0.24.0'",
    )
  })

  it('returns undefined when the dependency is absent', () => {
    expect(withRewrittenDependency(manifest('"numpy>=2"'), 'scanmate-ink', '0.24.0')).toBeUndefined()
  })

  it('returns undefined when the version is already the new one', () => {
    const content = manifest('"scanmate-ink>=0.24.0"')
    expect(withRewrittenDependency(content, 'scanmate-ink', '0.24.0')).toBeUndefined()
  })
})
