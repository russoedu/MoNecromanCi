import {
  UPDATE_KINDS,
  UPDATE_KIND_LABELS,
  classify,
  compareVersions,
  highestSpec,
  isNewer,
  parseVersion,
  rangeOperator,
  specVersion
} from './semver'

describe('parseVersion', () => {
  it('parses a plain release triple', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: undefined })
  })

  it('keeps a prerelease suffix as an opaque string', () => {
    expect(parseVersion('2.0.0-beta.1')?.prerelease).toBe('beta.1')
  })

  it('rejects anything that is not a numeric triple', () => {
    // A git ref, a calendar version and a range must all read as unparseable
    // rather than silently comparing as 0.0.0.
    expect(parseVersion('main')).toBeUndefined()
    expect(parseVersion('2024-01')).toBeUndefined()
    expect(parseVersion('^1.2.3')).toBeUndefined()
  })
})

describe('rangeOperator', () => {
  it.each([
    ['^1.2.3', '^'],
    ['~1.2.3', '~'],
    ['>=1.2.3', '>='],
    ['<=1.2.3', '<='],
    ['1.2.3', '']
  ])('reads %s as %s', (spec, expected) => {
    expect(rangeOperator(spec)).toBe(expected)
  })

  it('prefers the longer operator, so >= is never read as >', () => {
    // The regression this ordering exists to prevent: '>' would leave '=1.2.3'
    // as the version, which specVersion then rejects.
    expect(rangeOperator('>=1.2.3')).toBe('>=')
    expect(specVersion('>=1.2.3')).toBe('1.2.3')
  })
})

describe('specVersion', () => {
  it('strips the operator off a single constraint', () => {
    expect(specVersion('^1.2.3')).toBe('1.2.3')
    expect(specVersion('~4.5')).toBe('4.5')
  })

  it('refuses a spec whose shape it does not understand', () => {
    // Every one of these reaches a manifest in a real workspace, and every one
    // would be corrupted by a naive rewrite.
    expect(specVersion('npm:@typescript/typescript6@^6.0.2')).toBeUndefined()
    expect(specVersion('workspace:*')).toBeUndefined()
    expect(specVersion('git+https://example.test/a.git')).toBeUndefined()
    expect(specVersion('>=1.0.0 <3.0.0')).toBeUndefined()
    expect(specVersion('*')).toBeUndefined()
  })
})

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.3.0')).toBeLessThan(0)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('sorts a release above its own prereleases', () => {
    expect(compareVersions('1.2.3', '1.2.3-beta.1')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBeLessThan(0)
  })

  it('treats unparseable input as equal rather than throwing', () => {
    expect(compareVersions('main', '1.0.0')).toBe(0)
  })
})

describe('isNewer', () => {
  it('is strict — an equal version is not newer', () => {
    expect(isNewer('1.2.3', '1.2.3')).toBe(false)
    expect(isNewer('1.2.4', '1.2.3')).toBe(true)
  })
})

describe('classify', () => {
  it.each([
    ['1.2.3', '1.2.9', 'patch'],
    ['1.2.3', '1.5.0', 'minor'],
    ['1.2.3', '2.0.0', 'major']
  ])('buckets %s to %s as %s', (current, latest, expected) => {
    expect(classify(current, latest)).toBe(expected)
  })

  it('puts every 0.x package in the non-semver bucket', () => {
    // npm-check's own rule, and the reason the screenshot shows
    // `@mnci/eslint-config 0.1.15 -> 0.3.4` under Non-Semver rather than Minor.
    expect(classify('0.1.15', '0.3.4')).toBe('non-semver')
    expect(classify('0.1.15', '0.1.16')).toBe('non-semver')
    expect(classify('0.9.0', '1.0.0')).toBe('non-semver')
  })

  it('classifies by the CURRENT version, not the latest', () => {
    // Going 0.x -> 2.x is still unpredictable; the promise was never made.
    expect(classify('0.5.0', '2.0.0')).toBe('non-semver')
  })

  it('falls back to non-semver rather than throwing on junk', () => {
    expect(classify('main', '1.0.0')).toBe('non-semver')
  })
})

describe('highestSpec', () => {
  it('picks the highest parseable spec', () => {
    expect(highestSpec(['^1.2.3', '^1.9.0', '~1.5.0'])).toBe('^1.9.0')
  })

  it('never lets an unparseable spec win', () => {
    // The failure this guards: treating `workspace:*` as 0.0.0 would drag every
    // other project down to it.
    expect(highestSpec(['workspace:*', '^2.0.0'])).toBe('^2.0.0')
  })

  it('returns undefined when nothing is parseable', () => {
    expect(highestSpec(['workspace:*', '*'])).toBeUndefined()
  })
})

describe('report sections', () => {
  it('orders sections least-risky first, as npm-check does', () => {
    expect(UPDATE_KINDS).toEqual(['patch', 'minor', 'major', 'non-semver'])
  })

  it('labels every section', () => {
    for (const kind of UPDATE_KINDS) {
      expect(UPDATE_KIND_LABELS[kind].title).toBeTruthy()
      expect(UPDATE_KIND_LABELS[kind].blurb).toBeTruthy()
    }
  })
})
