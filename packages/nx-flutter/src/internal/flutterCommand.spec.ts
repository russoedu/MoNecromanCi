import { dartPackageName } from './dartPackageName'
import { flutterCommand } from './flutterCommand'

describe('flutterCommand', () => {
  const original = process.platform

  /** Repoints `process.platform`, which is a read-only getter. */
  function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  }

  afterEach(() => {
    setPlatform(original)
  })

  it('resolves the .bat shim on Windows', () => {
    // The SDK ships flutter.bat there; spawnSync cannot exec a bare `flutter`.
    setPlatform('win32')
    expect(flutterCommand()).toBe('flutter.bat')
  })

  it('resolves a bare flutter everywhere else', () => {
    setPlatform('linux')
    expect(flutterCommand()).toBe('flutter')
    setPlatform('darwin')
    expect(flutterCommand()).toBe('flutter')
  })
})

describe('dartPackageName', () => {
  it('converts mnci hyphens into Dart underscores', () => {
    // mnci permits hyphens in a project name, but pub rejects a hyphenated
    // package name outright — so this conversion is load-bearing, not cosmetic.
    expect(dartPackageName('my-app')).toBe('my_app')
    expect(dartPackageName('a-b-c')).toBe('a_b_c')
  })

  it('converts dots too — pub requires [a-z_][a-z0-9_]* and rejects them', () => {
    // mnci permits dots in a project name. Missing this would make `pub get`
    // fail on the generated pubspec, so it fails loudly rather than subtly —
    // but it would fail on every dotted Flutter project.
    expect(dartPackageName('my.app')).toBe('my_app')
    expect(dartPackageName('api.v2')).toBe('api_v2')
    expect(dartPackageName('my-app.v2')).toBe('my_app_v2')
  })

  it('leaves an already-valid name alone', () => {
    expect(dartPackageName('core')).toBe('core')
    expect(dartPackageName('web2')).toBe('web2')
  })
})
