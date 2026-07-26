import { readPubspecVersion, withWorkspaceResolution, writePubspecVersion } from './pubspec'

/** A pubspec shaped exactly like the one `flutter create` writes. */
const GENERATED = `name: shared
description: "A new Flutter package project."
version: 0.0.1
homepage:

environment:
  sdk: ^3.12.2
  flutter: ">=1.17.0"

dependencies:
  flutter:
    sdk: flutter

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^6.0.0
`

describe('readPubspecVersion', () => {
  it('reads the top-level version', () => {
    expect(readPubspecVersion(GENERATED)).toBe('0.0.1')
  })

  it('returns undefined when there is no top-level version (valid for an app)', () => {
    expect(readPubspecVersion('name: web\nenvironment:\n  sdk: ^3.6.0\n')).toBeUndefined()
  })

  it('ignores a nested version: key belonging to a dependency', () => {
    // Regression guard: an unanchored regex would match the nested one and
    // report a dependency's version as the project's own.
    const nested = `name: app
dependencies:
  some_pkg:
    version: 9.9.9
version: 1.2.3
`
    expect(readPubspecVersion(nested)).toBe('1.2.3')
  })
})

describe('writePubspecVersion', () => {
  it('rewrites the top-level version in place', () => {
    const updated = writePubspecVersion(GENERATED, '0.0.2')
    expect(updated).toContain('version: 0.0.2')
    expect(updated).not.toContain('version: 0.0.1')
  })

  it('leaves everything else byte-identical', () => {
    const updated = writePubspecVersion(GENERATED, '2.0.0')
    expect(updated.replace('version: 2.0.0', 'version: 0.0.1')).toBe(GENERATED)
  })

  it('leaves a pubspec with no version untouched rather than inventing one', () => {
    const noVersion = 'name: web\nenvironment:\n  sdk: ^3.6.0\n'
    expect(writePubspecVersion(noVersion, '1.0.0')).toBe(noVersion)
  })
})

describe('withWorkspaceResolution', () => {
  it('inserts `resolution: workspace` after the environment block', () => {
    const updated = withWorkspaceResolution(GENERATED)
    expect(updated).toContain('resolution: workspace')
    // It must land after `environment:`, which is where Dart documents it.
    expect(updated.indexOf('resolution: workspace')).toBeGreaterThan(
      updated.indexOf('environment:')
    )
    // …and before the dependencies it governs, i.e. not appended at the end.
    expect(updated.indexOf('resolution: workspace')).toBeLessThan(updated.indexOf('dependencies:'))
  })

  it('is idempotent — a second pass does not duplicate the key', () => {
    const once = withWorkspaceResolution(GENERATED)
    expect(withWorkspaceResolution(once)).toBe(once)
    expect(once.match(/resolution:/g)).toHaveLength(1)
  })

  it('preserves the rest of the pubspec, including the generated comments', () => {
    const updated = withWorkspaceResolution(GENERATED)
    expect(updated).toContain('description: "A new Flutter package project."')
    expect(updated).toContain('flutter_lints: ^6.0.0')
  })

  it('throws a diagnosable error when there is no environment block to anchor to', () => {
    expect(() => withWorkspaceResolution('name: broken\n')).toThrow(/no `environment:` block/)
  })
})
