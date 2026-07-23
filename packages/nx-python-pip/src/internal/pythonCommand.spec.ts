import { pythonCommand } from './pythonCommand'

describe('pythonCommand', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('resolves to "python" on win32 (python.org\'s Windows installer registers no python3.exe)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(pythonCommand()).toBe('python')
  })

  it('resolves to "python3" on linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(pythonCommand()).toBe('python3')
  })

  it('resolves to "python3" on darwin', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(pythonCommand()).toBe('python3')
  })
})
