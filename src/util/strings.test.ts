import { toSlug, toVariableToken } from './strings'

describe('toSlug', () => {
  it('preserves interior dots while kebab-casing spaces and camelCase', () => {
    expect(toSlug('JATO.Auto.Quotes Manager')).toBe('jato.auto.quotes-manager')
    expect(toSlug('jato.index')).toBe('jato.index')
  })

  it('strips leading and trailing separators', () => {
    expect(toSlug('  --Hello_World--  ')).toBe('hello-world')
  })

  it('strips leading/trailing dots and collapses dotted separator runs', () => {
    expect(toSlug('.hidden.name.')).toBe('hidden.name')
    expect(toSlug('jato . index')).toBe('jato.index')
    expect(toSlug('jato..index')).toBe('jato.index')
  })
})

describe('toVariableToken', () => {
  it('produces an upper snake token', () => {
    expect(toVariableToken('price-offers')).toBe('PRICE_OFFERS')
  })
})
