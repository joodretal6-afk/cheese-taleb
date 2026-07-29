# Project Phoenix

A production-oriented, original **AAA mobile Battle Royale** platform.

> Inspired by the genre (PUBG Mobile, Fortnite). **No copied assets, code, sounds,
> maps, or copyrighted material** — everything original.

- **Client engine:** Unreal Engine 5.6 (Android / iOS / Windows dev build)
- **Backend:** NestJS + TypeScript microservices (PostgreSQL, Redis, Kafka, gRPC/REST/WS)
- **Tools:** Web-based Map Editor + Enterprise React Admin Dashboard
- **Infra:** Docker, Kubernetes, GitHub Actions CI/CD, CDN, patch system

---

## How this project is actually built (read this first)

This is a multi-year, studio-scale platform. We build it the way a real studio does:
**one module at a time, each one working and tested before the next.** No
placeholder code shipped as "done", no fake implementations.

Two kinds of work, split by where each can be built and verified:

| Part | Who builds & tests it |
| --- | --- |
| Backend services, Map Editor (web), Admin Dashboard, tools, shared libs | **Built and tested here, end to end.** 🟢 |
| UE5 game client (C++/Blueprint, art integration, Android/iOS build) | **Code + step-by-step guidance written here; compiled, run, and tested on the developer's machine** (UE5 cannot be built in this environment). 🔵 |

The UE5 client is the one part that always needs a real machine with the Unreal
Editor. Everything else is fully deliverable here.

---

## Monorepo layout

```
phoenix/
  docs/            Architecture, schema, and per-subsystem design docs
  services/        Backend microservices (NestJS)
  editor/          Web-based Map Editor (React + 3D)
  admin/           Enterprise Admin Dashboard (React)
  client/          UE5 client source + setup guide (built on dev machine)
  packages/        Shared TypeScript libraries (types, protocols, config)
  infra/           Docker, Kubernetes, CI/CD, CDN, patch system
```

## Build roadmap (module order, dependencies respected)

Status: `▢ planned  ◐ in progress  ✅ done & tested`

0. ✅ **Architecture** — 9 subsystem design docs (`docs/`, ~7,000 lines)
1. ◐ **Foundation** — monorepo dirs done; shared types + docker-compose next
2. ✅ **Map Editor (web)** — terrain sculpt, water, gas circle, object/spawn/loot
   placement, `.phxmap` save/load *(verified headlessly)*
3. ✅ **Auth service** — register/login/me, JWT + bcrypt *(7 tests green)*
4. ✅ **Player Profile** *(9 tests)* · ✅ **Inventory + Wallet** *(7 tests)*
5. ✅ **Admin Dashboard** — overview/players/leaderboard/economy *(verified)*
6. ▢ **Matchmaking + Dedicated server contract**
7. ▢ **Store / Economy / Battle Pass**
8. 🔵 **UE5 client** — character, weapons, vehicles, networking (dev-machine build)
9. ▢ **LiveOps, analytics, security/anti-cheat, DevOps hardening**

Each module lands with: working code, tests, its own README, and (for services)
a runnable `docker-compose` slice.
