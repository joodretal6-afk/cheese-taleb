import { evaluatePurchase, findItem } from './catalog'

describe('evaluatePurchase', () => {
  it('allows a purchase with enough balance and returns debit + grant', () => {
    const item = findItem('ar_phoenix_gold')!
    const d = evaluatePurchase('ar_phoenix_gold', 2000, false)
    expect(d.ok).toBe(true)
    expect(d.debit).toEqual({ currency: item.currency, amount: item.price })
    expect(d.grant).toEqual({ itemId: 'ar_phoenix_gold', kind: 'skin' })
  })

  it('denies an unknown item', () => {
    expect(evaluatePurchase('nope', 9999, false)).toEqual({ ok: false, reason: 'unknown_item' })
  })

  it('denies insufficient funds', () => {
    expect(evaluatePurchase('ar_phoenix_gold', 100, false).reason).toBe('insufficient_funds')
  })

  it('denies re-buying a unique cosmetic that is already owned', () => {
    expect(evaluatePurchase('ar_phoenix_gold', 5000, true).reason).toBe('already_owned')
  })

  it('allows re-buying a non-unique crate even if owned', () => {
    const d = evaluatePurchase('crate_seasonal', 5000, true)
    expect(d.ok).toBe(true)
  })
})
