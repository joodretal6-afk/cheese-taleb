import { BadRequestException } from '@nestjs/common'
import { InventoryService } from './inventory.service'

describe('InventoryService', () => {
  let inv: InventoryService

  beforeEach(() => {
    inv = new InventoryService()
  })

  it('grants an item and lists it', () => {
    inv.grant('u1', 'ar_phoenix', 'weapon')
    expect(inv.owns('u1', 'ar_phoenix')).toBe(true)
    expect(inv.list('u1')).toHaveLength(1)
  })

  it('stacks quantity when granting the same item again', () => {
    inv.grant('u1', 'crate_common', 'crate', 2)
    inv.grant('u1', 'crate_common', 'crate', 3)
    expect(inv.list('u1')[0].quantity).toBe(5)
  })

  it('is idempotent when the same idempotency key is reused', () => {
    inv.grant('u1', 'skin_gold', 'skin', 1, 'order-123')
    inv.grant('u1', 'skin_gold', 'skin', 1, 'order-123')
    expect(inv.list('u1')[0].quantity).toBe(1)
  })

  it('revokes and removes an item at zero', () => {
    inv.grant('u1', 'ar_phoenix', 'weapon', 2)
    inv.revoke('u1', 'ar_phoenix', 2)
    expect(inv.owns('u1', 'ar_phoenix')).toBe(false)
  })

  it('credits and debits a wallet', () => {
    expect(inv.credit('u1', 'coins', 500, 'match reward')).toBe(500)
    expect(inv.debit('u1', 'coins', 200, 'store purchase')).toBe(300)
    expect(inv.balance('u1', 'coins')).toBe(300)
  })

  it('rejects a debit with insufficient funds', () => {
    inv.credit('u1', 'crystals', 40, 'welcome gift')
    expect(() => inv.debit('u1', 'crystals', 100, 'buy bundle')).toThrow(BadRequestException)
    expect(inv.balance('u1', 'crystals')).toBe(40)
  })

  it('does not double-apply an idempotent credit', () => {
    inv.credit('u1', 'crystals', 100, 'iap', 'receipt-1')
    inv.credit('u1', 'crystals', 100, 'iap', 'receipt-1')
    expect(inv.balance('u1', 'crystals')).toBe(100)
  })
})
