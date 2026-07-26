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
    // mnci validates names as [a-z][a-z0-9-]*, but pub rejects a hyphenated
    // package name outright — so this conversion is load-bearing, not cosmetic.
    expect(dartPackageName('my-app')).toBe('my_app')
    expect(dartPackageName('a-b-c')).toBe('a_b_c')
  })

  it('leaves an already-valid name alone', () => {
    expect(dartPackageName('core')).toBe('core')
    expect(dartPackageName('web2')).toBe('web2')
  })
})
