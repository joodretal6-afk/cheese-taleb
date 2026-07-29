import { BadRequestException, Injectable } from '@nestjs/common'
import { InventoryStore, type Currency, type ItemKind, type OwnedItem } from './store'

@Injectable()
export class InventoryService {
  private readonly store = new InventoryStore()

  /** Grant `quantity` of an item. Idempotent when an `idempotencyKey` is given. */
  grant(userId: string, itemId: string, kind: ItemKind, quantity = 1, idempotencyKey?: string): OwnedItem {
    if (quantity <= 0) throw new BadRequestException('quantity must be positive')
    const items = this.store.itemsOf(userId)
    if (this.store.seen(idempotencyKey)) return items.get(itemId) ?? this.zero(itemId, kind)

    const existing = items.get(itemId)
    if (existing) {
      existing.quantity += quantity
      return existing
    }
    const item: OwnedItem = { itemId, kind, quantity, acquiredAt: new Date().toISOString() }
    items.set(itemId, item)
    return item
  }

  /** Remove up to `quantity`; drops the entry when it hits zero. */
  revoke(userId: string, itemId: string, quantity = 1): void {
    const items = this.store.itemsOf(userId)
    const existing = items.get(itemId)
    if (!existing) throw new BadRequestException('item not owned')
    existing.quantity -= quantity
    if (existing.quantity <= 0) items.delete(itemId)
  }

  owns(userId: string, itemId: string): boolean {
    return this.store.itemsOf(userId).has(itemId)
  }

  list(userId: string): OwnedItem[] {
    return [...this.store.itemsOf(userId).values()]
  }

  // ---- wallet ----

  balance(userId: string, currency: Currency): number {
    return this.store.balanceOf(userId, currency)
  }

  credit(userId: string, currency: Currency, amount: number, reason: string, idempotencyKey?: string): number {
    if (amount <= 0) throw new BadRequestException('amount must be positive')
    if (this.store.seen(idempotencyKey)) return this.store.balanceOf(userId, currency)
    const next = this.store.balanceOf(userId, currency) + amount
    this.store.setBalance(userId, currency, next)
    this.store.record({ userId, currency, delta: amount, reason, at: new Date().toISOString() })
    return next
  }

  debit(userId: string, currency: Currency, amount: number, reason: string): number {
    if (amount <= 0) throw new BadRequestException('amount must be positive')
    const current = this.store.balanceOf(userId, currency)
    if (current < amount) throw new BadRequestException('insufficient funds')
    const next = current - amount
    this.store.setBalance(userId, currency, next)
    this.store.record({ userId, currency, delta: -amount, reason, at: new Date().toISOString() })
    return next
  }

  private zero(itemId: string, kind: ItemKind): OwnedItem {
    return { itemId, kind, quantity: 0, acquiredAt: new Date().toISOString() }
  }
}
