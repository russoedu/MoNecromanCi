import { toSlug, toVariableToken } from './strings'

describe('toSlug', () => {
  it('converts dots, spaces and camelCase to kebab-case', () => {
    expect(toSlug('JATO.Auto.Quotes Manager')).toBe('jato-auto-quotes-manager')
  })

  it('strips leading and trailing separators', () => {
    expect(toSlug('  --Hello_World--  ')).toBe('hello-world')
  })
})

describe('toVariableToken', () => {
  it('produces an upper snake token', () => {
    expect(toVariableToken('price-offers')).toBe('PRICE_OFFERS')
  })
})
