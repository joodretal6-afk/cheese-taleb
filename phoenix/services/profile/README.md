# Phoenix Profile Service

Player-profile microservice for Project Phoenix (NestJS). Owns the game-facing
profile: display name, XP, level, lifetime stats, and the leaderboard.

## Endpoints

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/profiles` | `{ userId, displayName }` | profile view |
| `GET` | `/profiles/:userId` | — | profile view |
| `POST` | `/profiles/:userId/match` | `{ kills, deaths, damage, placement }` | updated profile |
| `GET` | `/leaderboard?limit=` | — | ranked profile views |
| `GET` | `/health` | — | `{ status, service, time }` |

A *profile view* is the stored profile plus derived `level` and `progress`
(XP into the level and XP to the next).

## Design notes

- **Leveling** (`leveling.ts`): cumulative XP to reach level N is `100 * (N-1)^2`;
  `levelForXp` is its inverse. Pure and unit-tested independently.
- **Match XP** (`xpForMatch`): base + per-kill + per-damage + a placement bonus
  (big for a win). Recording a match updates stats and awards XP atomically.
- `ProfileRepository` is an interface; the in-memory impl backs tests and local
  runs, with a Postgres impl (`profile.*` tables) dropping in behind it.

## Run

```bash
cd phoenix/services/profile
npm install
npm test        # 9 tests (leveling + service), all green
npm run start   # http://localhost:4002
```
