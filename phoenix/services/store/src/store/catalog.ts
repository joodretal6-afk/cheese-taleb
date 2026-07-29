/**
 * Store catalog + pure purchase evaluation. The service layer applies the
 * decision (debit the wallet, grant the item) by calling the Inventory service;
 * this module just decides whether a purchase is allowed and what it costs —
 * fully testable with no I/O.
 */

export type Currency = 'coins' | 'crystals'
export type ItemKind = 'weapon' | 'skin' | 'attachment' | 'emote' | 'crate' | 'bundle'

export interface StoreItem {
  id: string
  name: string
  kind: ItemKind
  currency: Currency
  price: number
  /** Cosmetics you can only own once; crates/bundles are re-buyable. */
  unique: boolean
}

export const CATALOG: StoreItem[] = [
  { id: 'ar_phoenix_gold', name: 'AR Phoenix — Gold', kind: 'skin', currency: 'crystals', price: 1600, unique: true },
  { id: 'smg_ember', name: 'SMG Ember', kind: 'skin', currency: 'crystals', price: 1200, unique: true },
  { id: 'emote_victory', name: 'Victory Emote', kind: 'emote', currency: 'crystals', price: 450, unique: true },
  { id: 'crate_seasonal', name: 'Seasonal Crate', kind: 'crate', currency: 'coins', price: 300, unique: false },
  { id: 'bundle_starter', name: 'Starter Bundle', kind: 'bundle', currency: 'crystals', price: 990, unique: true },
]

export function findItem(id: string): StoreItem | undefined {
  return CATALOG.find((i) => i.id === id)
}

export type PurchaseDenial = 'unknown_item' | 'already_owned' | 'insufficient_funds'

export interface PurchaseDecision {
  ok: boolean
  reason?: PurchaseDenial
  debit?: { currency: Currency; amount: number }
  grant?: { itemId: string; kind: ItemKind }
}

export function evaluatePurchase(itemId: string, balance: number, alreadyOwned: boolean): PurchaseDecision {
  const item = findItem(itemId)
  if (!item) return { ok: false, reason: 'unknown_item' }
  if (item.unique && alreadyOwned) return { ok: false, reason: 'already_owned' }
  if (balance < item.price) return { ok: false, reason: 'insufficient_funds' }
  return {
    ok: true,
    debit: { currency: item.currency, amount: item.price },
    grant: { itemId: item.id, kind: item.kind },
  }
}
