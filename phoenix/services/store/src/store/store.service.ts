import { Injectable } from '@nestjs/common'
import { CATALOG, evaluatePurchase, type PurchaseDecision, type StoreItem } from './catalog'

/**
 * Store service. Purchasing is a two-step, cross-service operation: this service
 * decides whether the purchase is allowed and what it costs, then the gateway
 * (or a saga) debits the wallet and grants the item through the Inventory
 * service. Keeping the decision pure makes it trivially testable.
 */
@Injectable()
export class StoreService {
  catalog(): StoreItem[] {
    return CATALOG
  }

  /** Wallet balance and current ownership are supplied by the caller (from the
   * Inventory service); this returns the debit + grant to apply, or a denial. */
  purchase(itemId: string, balance: number, alreadyOwned: boolean): PurchaseDecision {
    return evaluatePurchase(itemId, balance, alreadyOwned)
  }
}
