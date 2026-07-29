export type ItemKind = 'weapon' | 'skin' | 'attachment' | 'emote' | 'crate'
export type Currency = 'coins' | 'crystals'

export interface OwnedItem {
  itemId: string
  kind: ItemKind
  quantity: number
  acquiredAt: string
}

export interface LedgerEntry {
  userId: string
  currency: Currency
  delta: number
  reason: string
  at: string
}

/**
 * In-memory store for inventory ownership and currency wallets. A PostgreSQL
 * implementation (`inventory.owned_items` + the double-entry `wallet_ledger`
 * in docs/02-database-schema.md) drops in behind the same shape. Idempotency
 * keys guard against double-granting on retried requests.
 */
export class InventoryStore {
  private readonly items = new Map<string, Map<string, OwnedItem>>()
  private readonly balances = new Map<string, Map<Currency, number>>()
  private readonly ledger: LedgerEntry[] = []
  private readonly seenKeys = new Set<string>()

  /** Returns true if this idempotency key was already applied. */
  seen(key?: string): boolean {
    if (!key) return false
    if (this.seenKeys.has(key)) return true
    this.seenKeys.add(key)
    return false
  }

  itemsOf(userId: string): Map<string, OwnedItem> {
    let m = this.items.get(userId)
    if (!m) {
      m = new Map()
      this.items.set(userId, m)
    }
    return m
  }

  balanceOf(userId: string, currency: Currency): number {
    return this.balances.get(userId)?.get(currency) ?? 0
  }

  setBalance(userId: string, currency: Currency, value: number): void {
    let m = this.balances.get(userId)
    if (!m) {
      m = new Map()
      this.balances.set(userId, m)
    }
    m.set(currency, value)
  }

  record(entry: LedgerEntry): void {
    this.ledger.push(entry)
  }

  ledgerOf(userId: string): LedgerEntry[] {
    return this.ledger.filter((e) => e.userId === userId)
  }
}
