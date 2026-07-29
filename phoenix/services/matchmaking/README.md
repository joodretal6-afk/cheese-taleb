# Phoenix Matchmaking Service

Skill-based, region-aware matchmaking (NestJS). Queues players and forms 100-
player battle-royale lobbies, filling with bots when a ticket has waited too long.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/queue` | enqueue `{ userId, mmr, region }` |
| `DELETE` | `/queue/:userId` | cancel a ticket |
| `GET` | `/queue/status` | queue depth by region |
| `POST` | `/queue/pump` | form matches now (ticker/allocator) |
| `GET` | `/health` | liveness |

## Design notes

- **`matchmaker.ts`** is pure: given tickets, a clock value, config and an id
  generator it returns formed matches + who is left waiting. Fully deterministic
  and unit-tested apart from NestJS.
- Lobbies never mix regions and keep MMR spread within `mmrWindow`. After
  `maxWaitMs`, a short lobby launches with bot-fill so players aren't stuck.
- Each returned `Match` is what the dedicated-server allocator (Agones fleet in
  `docs/07-devops-infra.md`) uses to spin up a game server.

## Run

```bash
cd phoenix/services/matchmaking
npm install && npm test   # 10 tests green (matcher + service)
npm run start             # http://localhost:4004
