# Phoenix Inventory Service

Inventory & wallet microservice (NestJS). Owns item ownership and the two-currency
wallet (`coins` soft / `crystals` premium).

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/inventory/:userId` | list owned items |
| `POST` | `/inventory/:userId/grant` | grant an item (idempotent) |
| `GET` | `/inventory/:userId/owns?itemId=` | ownership check |
| `GET` | `/wallet/:userId` | balances |
| `POST` | `/wallet/:userId/credit` | credit currency (idempotent) |
| `POST` | `/wallet/:userId/debit` | debit currency (rejects overdraw) |
| `GET` | `/health` | liveness |

## Design notes

- Grants and credits accept an `idempotencyKey` so retried purchase/reward
  requests never double-apply — critical for payment-driven grants.
- Every wallet change appends a ledger entry (double-entry `wallet_ledger` in
  the DB design); debits below balance are rejected.

## Run

```bash
cd phoenix/services/inventory
npm install && npm test   # 7 tests green
npm run start             # http://localhost:4003
```
