# Phoenix Admin Dashboard

Enterprise admin console for Project Phoenix (React + Vite, dark theme).

## Screens (live)

- **Overview** — KPIs (online, DAU, matches, revenue, server health), 7-day
  revenue chart, per-region health, recently active players.
- **Players** — searchable table with level, K/D, wins, status, and mute/ban
  actions.
- **Leaderboard** — global XP ranking.
- **Economy** — grant currency (idempotent) + store item catalogue.

More sections (Battle Pass, Seasons, Store Editor, Clans, Tournaments,
Anti-Cheat, Reports, Audit Log) are stubbed in the nav and land next.

## Data

`src/api.ts` calls the live services (auth/profile/inventory) and falls back to a
seeded demo dataset when the backend is unreachable, so the dashboard renders
standalone. Point it at a gateway with `VITE_API`.

## Run

```bash
cd phoenix/admin
npm install
npm run dev     # http://127.0.0.1:5373
```
