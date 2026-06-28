import { logger } from './logger'

describe('logger', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('writes info messages as-is to stdout', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    logger.info('hello')
    expect(logSpy).toHaveBeenCalledWith('hello')
  })

  it('prefixes step messages with an arrow', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    logger.step('working')
    expect(logSpy).toHaveBeenCalledWith('→ working')
  })

  it('prefixes success messages with a checkmark', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    logger.success('done')
    expect(logSpy).toHaveBeenCalledWith('✓ done')
  })

  it('prefixes warnings with a bang on stderr-bound console.warn', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    logger.warn('careful')
    expect(warnSpy).toHaveBeenCalledWith('! careful')
  })

  it('prefixes errors with a cross on console.error', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    logger.error('broken')
    expect(errorSpy).toHaveBeenCalledWith('✗ broken')
  })
})
