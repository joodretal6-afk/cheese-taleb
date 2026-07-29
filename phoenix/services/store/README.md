# Phoenix Store & Battle Pass Service

Store catalogue, purchase evaluation, and Battle Pass progression (NestJS).

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/store/catalog` | list purchasable items |
| `POST` | `/store/purchase` | evaluate a purchase → debit + grant, or denial |
| `GET` | `/battlepass/:userId` | tier, XP, premium, claimed |
| `POST` | `/battlepass/:userId/xp` | add pass XP (advances tiers) |
| `POST` | `/battlepass/:userId/premium` | activate premium track |
| `POST` | `/battlepass/:userId/claim` | claim a tier reward `{ tier, track }` |
| `GET` | `/health` | liveness |

## Design notes

- **Purchasing is a saga.** `evaluatePurchase` (pure) decides allow/deny and
  returns the debit + grant; the gateway then applies them via the Inventory
  service (wallet debit + item grant, both idempotent). Unique cosmetics can't
  be re-bought; crates/bundles can.
- **Battle Pass** maps XP → tier (`XP_PER_TIER`), with free + premium reward
  tracks. Claims validate tier reached, no double-claim, and premium ownership.

## Run

```bash
cd phoenix/services/store
npm install && npm test   # 11 tests green (catalog + battle pass)
npm run start             # http://localhost:4005
```
