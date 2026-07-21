import { logger } from './logger'

describe('logger', () => {
  it('prefixes each severity with its glyph', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    logger.info('plain')
    logger.step('doing')
    logger.success('done')
    logger.warn('careful')
    logger.error('broken')

    expect(logSpy).toHaveBeenCalledWith('plain')
    expect(logSpy).toHaveBeenCalledWith('→ doing')
    expect(logSpy).toHaveBeenCalledWith('✓ done')
    expect(warnSpy).toHaveBeenCalledWith('! careful')
    expect(errorSpy).toHaveBeenCalledWith('✗ broken')

    jest.restoreAllMocks()
  })
})
