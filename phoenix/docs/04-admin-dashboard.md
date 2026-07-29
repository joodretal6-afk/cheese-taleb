# 04 — Enterprise Admin Dashboard

> **Owner:** Lead UI/UX + Frontend Engineer
> **Package:** `phoenix/admin/`
> **Consumers:** Live-ops, Economy, Community/Support, Trust & Safety, Data, Engineering, Studio leadership
> **Backend contract:** the NestJS microservices defined in the platform architecture (`gRPC` internally, `REST + WS` at the edge). This dashboard talks **only** to the **BFF/Admin Gateway** (`admin-gateway`), never directly to internal services.

This document is the buildable spec for the single internal control plane for Project Phoenix. It is an **operator tool**, not a marketing site: dense, keyboard-friendly, dark-theme-first, and audited on every mutating action.

---

## 1. Tech stack

| Layer | Choice | Justification |
| --- | --- | --- |
| Language | **TypeScript (strict)** | Shared DTOs with the NestJS backend via `packages/contracts`. One source of truth for API types kills whole classes of integration bugs. |
| Framework | **React 18** | Team standard; concurrent rendering helps the heavy live dashboards; largest hiring pool. |
| Build / dev | **Vite** + SWC | Matches the rest of the repo, instant HMR on a large app. |
| Routing | **React Router v6 (data routers)** | Route-level `loader`/`action` maps 1:1 onto our BFF endpoints; nested layouts model the sidebar → section → screen hierarchy directly. |
| Component / design system | **Mantine v7** (core + `@mantine/hook`, `@mantine/dates`, `@mantine/notifications`, `@mantine/spotlight`, `@mantine/form`) | Batteries-included, first-class dark theme, accessible primitives, and — critically for an admin — a genuinely good `DataTable`/`Table`, `Modal`, `Drawer`, `Combobox`, date pickers, and a command palette (`Spotlight`). Far less bespoke work than Radix/Tailwind from scratch. Design tokens live in one `theme.ts`. |
| Data grid | **TanStack Table v8** (headless) rendered with Mantine cells | Server-side pagination/sort/filter, column virtualization, row selection for bulk moderation. Mantine's table is fine for small lists; TanStack handles the 10M-row player table. |
| Server state / data fetching | **TanStack Query v5** | Caching, background refetch, optimistic updates, request dedupe, and polling for near-real-time panels. This is 80% of our "state". |
| Client state | **Zustand** | Small, un-opinionated stores for cross-cutting UI state only (active org/region, theme, command palette, feature flags, the current admin's session/permissions). Everything server-owned stays in TanStack Query. |
| Realtime | **Native WebSocket** wrapped in a typed `useLiveChannel` hook, backed by the gateway's WS multiplexer | Live player counts, server health, and the moderation queue push over WS. Query cache is updated from WS messages so components don't special-case "live vs fetched". |
| Charts | **Recharts** for standard analytics (line/area/bar/pie/funnel); **visx** reserved for two bespoke views (retention cohort heatmap, world drop-heatmap overlay) | Recharts covers 90% of dashboards with almost no code; visx gives full control for the two visualizations Recharts can't do cleanly. All charts consume the shared color/scale tokens (see `dataviz` conventions). |
| Forms & validation | **Mantine Form** + **Zod** (schemas re-exported from `packages/contracts`) | The same Zod schema validates in the browser and on the NestJS service — no drift between client hints and server rules. |
| Auth | **OIDC / SSO** (Okta / Google Workspace) via PKCE, short-lived access token + refresh, plus mandatory **TOTP 2FA** step-up for privileged actions | Studio staff already have SSO; we never store passwords for admins. |
| i18n | **react-i18next** | Ops teams are distributed (EN/AR/KO/PT-BR at launch). |
| Tables/CSV/export | **@tanstack/table** export + server-generated signed CSV/Parquet for large exports | Big exports run async on the backend and drop a download link — the browser never streams 2M rows. |
| Testing | **Vitest** + **React Testing Library** (unit/integration), **Playwright** (E2E, incl. RBAC matrix), **MSW** (mock the BFF in dev/test) | MSW lets us build every screen before the real service exists. |
| Observability | **Sentry** (errors + traces) + a thin `track()` wrapper to the analytics service | We monitor the tool that monitors the game. |
| Feature flags | **Unleash** client (server-evaluated, cached) | Roll screens out per-team; kill-switch risky panels. |

**Non-negotiable UI conventions**

- **Dark theme first**, light theme supported. Both derive from tokens in `theme.ts`; no hard-coded hex in components.
- **Every mutating control is permission-gated in the UI *and* re-checked on the server.** UI gating is UX, not security.
- **Dangerous actions require a typed confirmation** (type the player's handle / SKU id) and, above a risk threshold, a **step-up 2FA challenge**.
- **Optimistic where safe, pessimistic where money or bans are involved.** Economy and moderation writes wait for server confirmation.

---

## 2. Backend service map (what the dashboard calls)

Everything routes through **`admin-gateway`** (a NestJS BFF). The gateway fans out over gRPC to the domain services below, enforces RBAC, and emits an audit event for every mutation. The "Service" column names the *system of record* the gateway proxies to.

| Domain service | Owns | Read surface | Write surface |
| --- | --- | --- | --- |
| `auth-svc` | Admin identity, SSO, sessions, 2FA, RBAC roles/permissions | roles, permissions, admin users, sessions | assign role, revoke session, force 2FA reset |
| `account-svc` | Player accounts, identity, KYC-lite, region | player search, profile | rename, region move, account flags |
| `profile-svc` | Player progression, stats, MMR | stats, match history, MMR | manual MMR adjust (rare, gated) |
| `inventory-svc` | Player-owned items, currency wallets | inventory, wallet balances | grant/revoke item, adjust currency (gated) |
| `moderation-svc` | Bans, mutes, warnings, restrictions, sanction history | sanction history, active restrictions | ban / unban / mute / warn / shadow-restrict |
| `report-svc` | Player reports, evidence, triage queue | report queue, evidence bundles | assign, resolve, escalate reports |
| `support-svc` | Tickets, macros, CSAT | ticket queue, threads | reply, tag, close, refund-request |
| `catalog-svc` | Store products, bundles, prices, skins/weapons/vehicles definitions | product & item catalog | create/edit/publish/schedule products & cosmetics |
| `economy-svc` | Currencies, entitlements, purchase ledger, loot tables & drop rates | ledger, loot tables, drop rates, sinks/sources | edit loot table, adjust drop rate (gated + review) |
| `liveops-svc` | Seasons, battle pass, events, daily rewards, missions, schedules | current/planned schedule | create/edit/schedule/rollback all live-ops entities |
| `notify-svc` | Push notifications, in-game inbox | campaigns, delivery stats | compose, target, schedule, send |
| `clan-svc` | Clans/guilds, membership, clan economy | clan search, roster | disband, transfer ownership, sanction clan |
| `tournament-svc` | Tournaments, brackets, prizes | brackets, standings | create/seed/advance/cancel, distribute prizes |
| `world-svc` | Maps, POIs, loot spawn config, world versions | map list, POI + spawn config | stage/publish map version, edit spawn tables |
| `bot-svc` | NPC/bot profiles, difficulty, fill policy | bot roster, per-mode fill config | edit bot difficulty, fill %, behavior profile |
| `match-svc` | Matchmaking, live matches, dedicated servers | live matches, server fleet health | drain/restart server, cancel match (gated) |
| `analytics-svc` | KPIs, funnels, retention, revenue rollups | all analytics/chart datasets | (read-only; saved views only) |
| `log-svc` | Structured app logs, security events | searchable logs | (read-only) |
| `audit-svc` | Immutable admin audit trail | audit search/export | (append-only; written by the gateway, never by UI) |
| `flag-svc` | Feature flags / kill switches | flag state | toggle flag (gated) |

**Transport summary:** browser ⇄ `admin-gateway` over **HTTPS REST** (queries + mutations) and **WSS** (live channels). Gateway ⇄ services over **gRPC**. Bulk exports are produced async and delivered as signed URLs.

---

## 3. Information architecture & navigation

A persistent left sidebar with collapsible groups, a top bar (global search / command palette, region + environment switcher, current-admin menu, environment badge), and the main work area. A global **Spotlight command palette** (`⌘K`) jumps to any screen, player, SKU, ticket, or action the admin is allowed to perform.

```
Top bar:  [☰]  Phoenix Admin   ⌘K search…      [env: PROD ▾] [region: Global ▾]   🔔  👤 me ▾
──────────────────────────────────────────────────────────────────────────────
Sidebar
├─ 📊 Overview
│    Live Ops Board · Server Health · Revenue · Analytics
├─ 🧍 Players
│    Search · Player Detail · Inventory Editor · Sessions
├─ 💰 Economy
│    Store Editor · Cosmetics (Skins/Weapons/Vehicles) · Bundles
│    Loot Tables & Drop Rates · Currency & Ledger
├─ 🗓️ LiveOps
│    Seasons · Battle Pass · Events · Daily Rewards · Missions · Schedule
├─ 📣 Engagement
│    Push & Inbox Campaigns
├─ 🤝 Community
│    Clans · Tournaments · Reports Queue · Support Tickets
├─ 🗺️ Content
│    Maps & Spawns · NPC / Bot Management
├─ 🛠️ Ops
│    Live Matches · Server Fleet · Logs · Feature Flags
├─ 🔒 Trust & Safety
│    Moderation Queue · Sanction History · Case Files
└─ ⚙️ Admin
     Users · Roles & Permissions · Audit Log · 2FA & Sessions · Settings
```

Every group and every screen is **RBAC-scoped**: a sidebar item that the admin has no permission for is hidden, and the route itself hard-blocks (403 screen) so deep links can't bypass the nav.

---

## 4. Screens

For each major screen: **data shown**, **service/API called (via `admin-gateway`)**, and **key actions**. All paths below are gateway routes (`/api/admin/...` prefix omitted for brevity).

### 4.1 Overview

#### Live Ops Board (home)
- **Data:** concurrent players (CCU) live gauge; new sessions/min; matches in progress; queue times per mode/region; current active season/event banner; today's revenue vs. 7-day avg; top 5 alerts (server, economy anomaly, moderation backlog).
- **Calls:** `WS /live/overview` (CCU, sessions, queues pushed every 2–5s); `GET /analytics/kpi/today`; `GET /liveops/active`; `GET /ops/alerts`.
- **Actions:** drill into any tile → its section; acknowledge/snooze an alert (`POST /ops/alerts/:id/ack`); jump to on-call runbook link.

#### Server Health
- **Data:** dedicated-server fleet map (region → clusters → instances), CPU/mem/tick-rate, session count per instance, unhealthy/draining nodes, matchmaking pool depth.
- **Calls:** `GET /ops/servers` + `WS /live/servers`; `GET /match/pools`.
- **Actions:** drain node, restart node, cordon region, force-scale request (all gated `ops:servers:write` + confirmation).

#### Revenue
- **Data:** gross/net revenue (day/week/month), by product type (battle pass, direct SKU, bundle, currency pack), ARPDAU, ARPPU, paying-user %, refund rate, top SKUs, revenue by region/platform.
- **Calls:** `GET /analytics/revenue?range&breakdown`; `GET /economy/ledger/summary`.
- **Actions:** change range/breakdown; save view; export CSV (async, `POST /analytics/export`).

#### Analytics
- **Data:** DAU/WAU/MAU + stickiness; **retention cohort heatmap** (D1/D7/D30, visx); acquisition & churn; **funnel** (install → tutorial → first match → first purchase); session length; mode popularity; engagement by feature.
- **Calls:** `GET /analytics/dau`, `/analytics/retention`, `/analytics/funnel`, `/analytics/segments`.
- **Actions:** filter by cohort/region/platform/version; compare date ranges; save & share view; export.

---

### 4.2 Player Management

#### Player Search
- **Data:** searchable, server-paginated table — handle, player id, region, platform, level, MMR, VIP/spend tier, account status (active/banned/muted/flagged), last seen.
- **Calls:** `GET /players?query&filters&page&sort` (`account-svc` + `profile-svc` join in gateway).
- **Actions:** open detail; quick-ban / quick-mute from row (gated, confirm); bulk-select → bulk sanction (gated).

#### Player Detail
- **Data:** identity & account flags; progression & stats; MMR & rank; match history (last N, link to match); current sanctions; devices & recent IP regions; purchase history & lifetime value; linked social/clan.
- **Calls:** `GET /players/:id` (aggregates `account`, `profile`, `moderation`, `economy`); `GET /players/:id/matches`; `GET /players/:id/sanctions`; `GET /players/:id/purchases`.
- **Actions:** **ban / unban** (duration, reason code, evidence, internal note); **mute** (chat/voice, duration); **warn** (templated message → in-game inbox); rename; region move; open inventory editor; force logout / revoke sessions; issue support-driven refund request; add case note. Every action → typed confirm + `moderation-svc`/`account-svc`; high-risk → step-up 2FA; all audited.

#### Inventory Editor
- **Data:** owned items grouped (skins, weapons, vehicles, emotes, consumables, currency wallets), acquisition source & date, equipped state, tradability/lock state.
- **Calls:** `GET /players/:id/inventory`; `GET /catalog/items?ids=` for display metadata.
- **Actions:** grant item (search catalog → add, with reason), revoke item, adjust currency balance (**hard-gated** `economy:wallet:write`, dual-control above threshold), lock/unlock item, restore from purchase ledger. Writes go to `inventory-svc`/`economy-svc`; every grant/revoke lands in the audit trail and the player's ledger.

#### Sessions
- **Data:** active + recent sessions per player, device, platform, IP region, session start, current server.
- **Calls:** `GET /players/:id/sessions`.
- **Actions:** revoke session, force logout all.

---

### 4.3 Economy

#### Store Editor
- **Data:** product catalog (SKUs, bundles), price per currency & per region/platform, availability window, visibility (draft/scheduled/live/archived), featured slots/merchandising order, purchase limits.
- **Calls:** `GET /catalog/products`; `GET /catalog/products/:id`.
- **Actions:** create/duplicate product; edit price matrix (real-money + soft/hard currency); set schedule; assign featured slot & sort; **stage → review → publish** (publishing gated `economy:store:publish` + change-summary diff shown before commit). All to `catalog-svc`; publishes emit a config version.

#### Cosmetics — Skin / Weapon / Vehicle Editors
- **Data:** cosmetic definitions with previews: id, name, rarity, category, asset bundle ref, attach points/skeleton (weapon/vehicle), stat-neutral confirmation (BR fairness), localization strings, release/retire dates.
- **Calls:** `GET /catalog/cosmetics?type=skin|weapon|vehicle`; `GET /catalog/cosmetics/:id`.
- **Actions:** create/edit cosmetic; upload/reference asset bundle (validated against `world-svc`/CDN); set rarity & category; bind to loot tables & store products; preview (renders CDN preview asset); publish/retire. `catalog-svc`. **Weapons/vehicles are cosmetic-only — no gameplay stat editing here** (enforced: the schema has no stat fields), preserving competitive fairness.

#### Bundles
- **Data:** bundle contents, component SKUs, bundle price vs. sum, discount %, window.
- **Calls:** `GET /catalog/bundles`.
- **Actions:** compose bundle, set discount, schedule, publish (gated).

#### Loot Tables & Drop Rates
- **Data:** loot tables per source (crate, event, pass, world-spawn tier); entries with item, weight, computed probability, pity/duplicate-protection rules; per-region legal disclosure values (odds disclosure).
- **Calls:** `GET /economy/loot-tables`; `GET /economy/loot-tables/:id`.
- **Actions:** edit weights (live-computed probabilities + a **10k-pull Monte-Carlo simulator** panel before save), add/remove entries, set pity rules, **publish with mandatory reviewer approval** (dual-control, `economy:loot:publish`), preview the region odds-disclosure text. `economy-svc`. Drop-rate changes are heavily audited and diffed.

#### Currency & Ledger
- **Data:** soft/hard currency definitions; global sinks & sources chart; purchase/grant/spend ledger (immutable), refunds; anomaly flags (mint spikes).
- **Calls:** `GET /economy/currencies`; `GET /economy/ledger?filters`; `GET /economy/sinks-sources`.
- **Actions:** define currency (rare, gated); flag/investigate ledger anomaly; export ledger slice. Ledger is append-only — no edits, only compensating entries via inventory editor.

---

### 4.4 LiveOps

#### Seasons
- **Data:** season timeline (start/end, theme, ranked reset), linked battle pass/events, state (draft/scheduled/live/ended).
- **Calls:** `GET /liveops/seasons`, `GET /liveops/seasons/:id`.
- **Actions:** create season, set window, attach pass/events, schedule, rollback (gated). `liveops-svc`.

#### Battle Pass Manager
- **Data:** track (free + premium lanes), tiers with XP thresholds & rewards, price, XP curve chart, purchase & tier-completion stats (live).
- **Calls:** `GET /liveops/passes/:id`; `GET /analytics/pass/:id/progress`.
- **Actions:** add/edit tiers, assign rewards (from catalog), edit XP curve (with curve preview), set price, schedule, publish; hotfix a reward (gated + audited). Rewards bound to `catalog-svc`; pass config to `liveops-svc`.

#### Events
- **Data:** event list (limited-time modes, themed events), window, targeting (region/platform/segment), linked missions/rewards, config payload.
- **Calls:** `GET /liveops/events`, `GET /liveops/events/:id`.
- **Actions:** create/edit/clone event, target, schedule, enable/disable via kill-switch, rollback. `liveops-svc` (+ `flag-svc` for kill-switch).

#### Daily Rewards
- **Data:** daily/weekly login reward calendar, streak rules, reward-per-day.
- **Calls:** `GET /liveops/daily-rewards`.
- **Actions:** edit calendar & streak rules, schedule, publish (gated).

#### Missions
- **Data:** mission/quest definitions (objective type, target count, reward, scope: daily/weekly/event/seasonal), completion funnel.
- **Calls:** `GET /liveops/missions`, `GET /analytics/missions/:id`.
- **Actions:** create/edit mission, set objective + reward, assign to event/pass, schedule, publish. `liveops-svc`.

#### Schedule (unified calendar)
- **Data:** one Gantt-style calendar of everything live-ops: seasons, passes, events, store rotations, sales, notifications — overlap/conflict warnings.
- **Calls:** `GET /liveops/schedule?range` (aggregates liveops + catalog + notify).
- **Actions:** drag to reschedule (writes back to owning service, gated), detect & warn on conflicts, publish a "calendar snapshot" for stakeholders.

---

### 4.5 Engagement — Push & Inbox Campaigns
- **Data:** campaign list, audience (segment/region/platform/version), message (localized push + optional in-game inbox item with attached reward), schedule, delivery & open/CTR stats.
- **Calls:** `GET /notify/campaigns`, `GET /notify/campaigns/:id/stats`; audience sizing `POST /analytics/segment/estimate`.
- **Actions:** compose (localized), pick/estimate audience, attach reward (catalog), A/B split, send test to self, schedule/send (gated `engagement:push:send`; large-audience sends require approval), cancel scheduled. `notify-svc`.

---

### 4.6 Community

#### Clan Manager
- **Data:** clan search (name, tag, member count, region, activity, flags); clan detail — roster with roles, clan bank/economy, activity, sanction history.
- **Calls:** `GET /clans?query`; `GET /clans/:id`.
- **Actions:** rename/retag (policy), transfer ownership, remove member, disband, sanction clan (name violations), lock clan chat. `clan-svc`; sanctions dual-written to `moderation-svc` + audit.

#### Tournament Manager
- **Data:** tournament list & detail — format (bracket/points), participants/teams, seeding, schedule, live standings, prize pool & distribution status.
- **Calls:** `GET /tournaments`, `GET /tournaments/:id`, `WS /live/tournaments/:id`.
- **Actions:** create tournament, define format/rules, seed, open/close registration, advance rounds, adjudicate disputes, cancel, **distribute prizes** (gated `community:tournament:payout` + dual-control, writes entitlements via `economy-svc`). `tournament-svc`.

#### Reports Queue
- **Data:** triage queue of player reports — category (cheat, chat abuse, name, griefing), priority, reporter/target, evidence bundle (chat log, match clip ref, kill graph), status, assignee, SLA timer.
- **Calls:** `GET /reports?filters&queue`; `GET /reports/:id` (evidence); `WS /live/reports` (new-report push).
- **Actions:** claim/assign, open target's player detail, apply sanction inline (ban/mute/warn), resolve (upheld/rejected/duplicate) with reason code, escalate to case file, bulk-resolve duplicates. `report-svc` (+ `moderation-svc` on sanction). SLA + reviewer decisions audited.

#### Support Tickets
- **Data:** ticket queue — subject, category (billing, account, bug, appeal), priority, requester, status, assignee, CSAT, SLA; threaded conversation with player + internal notes.
- **Calls:** `GET /support/tickets?filters`; `GET /support/tickets/:id`.
- **Actions:** claim, reply (macros/canned responses, localized), attach reward/compensation (catalog+economy, gated), request refund (`economy-svc`, gated), link to player detail, tag, escalate, close, merge duplicates. `support-svc`.

---

### 4.7 Content

#### Maps & Spawns
- **Data:** map list & versions (from the Map Editor pipeline), state (staged/published), POIs, loot-spawn tables per zone/tier, rotation eligibility, minimap thumbnail; **drop-heatmap overlay** (visx) over the minimap.
- **Calls:** `GET /world/maps`, `GET /world/maps/:id/version/:v`, `GET /world/maps/:id/spawns`.
- **Actions:** stage a Map Editor export, diff against live version, edit loot-spawn table & tier weights, set rotation eligibility, **publish map version** (gated `content:map:publish` + review, emits world config version), rollback. `world-svc`. (Geometry authoring stays in the Map Editor; this screen manages *config + release*.)

#### NPC / Bot Management
- **Data:** bot roster & behavior profiles; per-mode/per-skill-bracket **fill policy** (target bot % vs. real players, backfill rules); difficulty parameters (aim, reaction, aggression) per profile; observed win/kill distributions.
- **Calls:** `GET /bots/profiles`, `GET /bots/fill-policy`, `GET /analytics/bots/outcomes`.
- **Actions:** edit difficulty profile, set fill % per mode/bracket, A/B a profile, enable/disable a profile via kill-switch, schedule fill changes for events. `bot-svc` (+ `flag-svc`). Changes affecting matchmaking fairness are gated + audited.

---

### 4.8 Ops

#### Live Matches
- **Data:** in-progress matches — mode, region, server, player/bot count, phase/circle state, duration, flagged anomalies (impossible stats).
- **Calls:** `GET /match/live?filters`; `WS /live/matches`.
- **Actions:** inspect match, spectate-link (if enabled), cancel/void match (gated `ops:match:write`), flag for anti-cheat review. `match-svc`.

#### Server Fleet
- (Shares data with Overview → Server Health, in a table-centric ops view.)
- **Actions:** drain/restart/cordon; view per-node logs (deep-link to Logs).

#### Logs
- **Data:** structured, searchable app + security logs — service, level, correlation/trace id, player id, message, timestamp; saved queries; live tail.
- **Calls:** `GET /logs?query&service&level&range`; `WS /live/logs` (tail). Read-only.
- **Actions:** search, filter, follow trace id across services, save query, open trace in Sentry.

#### Feature Flags
- **Data:** flags/kill-switches — key, description, state per env/region, owner, rollout %.
- **Calls:** `GET /flags`.
- **Actions:** toggle, set rollout %, scope to region (gated `ops:flags:write` + confirm, audited). `flag-svc`.

---

### 4.9 Trust & Safety

#### Moderation Queue
- **Data:** unified sanction/appeal work queue (auto-flags from anti-cheat + manual reports), risk score, evidence, suggested action.
- **Calls:** `GET /moderation/queue`; `WS /live/moderation`.
- **Actions:** apply/adjust/lift sanction, batch actions, escalate to case file, review appeals. `moderation-svc`.

#### Sanction History
- **Data:** global searchable log of all sanctions — target, type, duration, reason, moderator, evidence link, appeal status.
- **Calls:** `GET /moderation/sanctions?filters`.
- **Actions:** search, review, lift/reduce (gated), export.

#### Case Files
- **Data:** grouped multi-report/multi-signal cases (e.g., a cheating ring), linked players/clans, evidence, timeline, assigned investigator.
- **Calls:** `GET /moderation/cases`, `GET /moderation/cases/:id`.
- **Actions:** link/unlink entities, add evidence & notes, apply coordinated sanctions, close case. Fully audited.

---

### 4.10 Admin

#### Users
- **Data:** admin accounts — name, SSO identity, assigned roles, teams, 2FA status, last login, active sessions, status.
- **Calls:** `GET /admin/users` (`auth-svc`).
- **Actions:** invite (SSO), assign/revoke roles, deactivate, force 2FA reset, revoke sessions. Gated `admin:users:write`, dual-control for granting privileged roles.

#### Roles & Permissions
- **Data:** roles, the permissions each grants, member count; permission catalog grouped by domain.
- **Calls:** `GET /admin/roles`, `GET /admin/permissions`.
- **Actions:** create/edit role, toggle permissions, clone role, deprecate role. Gated `admin:rbac:write`; **changes require a second approver** (dual-control) and are audited. See §5.

#### Audit Log
- **Data:** immutable, append-only stream of every admin action — actor, role used, action, target entity, before/after diff, IP, timestamp, 2FA-verified flag, correlation id.
- **Calls:** `GET /audit?actor&action&entity&range` (`audit-svc`, read-only); export async.
- **Actions:** search/filter, view diff, export (signed CSV). No mutation possible from the UI. See §6.

#### 2FA & Sessions
- **Data:** the current admin's 2FA enrollment, active sessions, recovery status; org-wide 2FA policy.
- **Calls:** `GET /admin/me/2fa`, `GET /admin/me/sessions`.
- **Actions:** enroll/re-enroll TOTP, revoke own sessions.

#### Settings
- **Data:** org/environment settings, SLA thresholds, notification routing, localization, theme defaults.
- **Actions:** edit (gated), audited.

---

## 5. RBAC model

### 5.1 Shape
**Admins → Roles → Permissions.** Roles are collections of permissions; an admin holds one or more roles; effective permission set is the union. Permissions are **never assigned directly** to a person — only via roles — so access is auditable and revocable in one place. RBAC is defined in `auth-svc` and enforced at **three layers**:

1. **UI** — hides nav/controls the admin can't use (UX only).
2. **`admin-gateway`** — the real gate: every route declares required permission(s); the gateway rejects with 403 before touching a domain service.
3. **Domain service** — defense in depth; sensitive services re-check scope on the gRPC call.

### 5.2 Permission granularity
Permissions are `domain:resource:action`, optionally **scoped** by region/environment/segment.

| Example permission | Grants |
| --- | --- |
| `players:profile:read` | view player detail |
| `moderation:sanction:write` | issue bans/mutes/warns |
| `moderation:sanction:lift` | lift/reduce sanctions |
| `economy:store:read` / `economy:store:publish` | view vs. publish store changes |
| `economy:loot:publish` | publish loot-table/drop-rate changes (dual-control) |
| `economy:wallet:write` | adjust player currency (dual-control above threshold) |
| `liveops:*:write` | edit live-ops entities |
| `community:tournament:payout` | distribute prizes (dual-control) |
| `content:map:publish` | publish a map version |
| `ops:servers:write` | drain/restart servers |
| `admin:rbac:write` | edit roles/permissions (dual-control) |
| `audit:read` | read audit log |

**Scope** narrows a grant, e.g. a role can hold `moderation:sanction:write @ region=KR` (Korea moderation only) or `@ env=STAGING`. The gateway evaluates `action-permitted AND scope-matches(target)`.

### 5.3 Sensitivity tiers (what a permission triggers)

| Tier | Example actions | Extra controls |
| --- | --- | --- |
| **Read** | view players, analytics, logs | none |
| **Standard write** | warn player, reply to ticket, edit draft store item | confirmation dialog |
| **Sensitive write** | ban, publish store, edit loot table, toggle prod flag | **typed confirmation + step-up 2FA** |
| **Dual-control** | RBAC changes, large currency adjust, tournament payout, loot-rate publish, prod kill-switch | requires a **second approver** with the same permission before it commits |

### 5.4 Suggested seed roles

| Role | Core permissions (abbreviated) |
| --- | --- |
| **Support Agent** | `players:*:read`, `support:*:*`, `moderation:sanction:write` (warn/mute only), `inventory:grant` (compensation, capped) |
| **Moderator** | `players:*:read`, `moderation:*:*`, `report:*:*`, `community:clan:sanction` |
| **T&S Lead** | Moderator + `moderation:sanction:lift`, `moderation:case:*`, dual-control approver |
| **Economy Designer** | `economy:*:read/write`, `catalog:*:*`, `economy:store:publish`, `economy:loot:publish` (as one side of dual-control) |
| **LiveOps Manager** | `liveops:*:*`, `engagement:push:*`, `content:map:read` |
| **Content Manager** | `content:*:*`, `catalog:cosmetics:*` |
| **Ops / SRE** | `ops:*:*`, `logs:read`, `flags:write`, `match:*:*` |
| **Analyst** | `analytics:*:read`, `economy:ledger:read`, `audit:read` |
| **Studio Admin** | `admin:*:*` (RBAC + users), always dual-control, always 2FA |
| **Read-Only Auditor** | `*:*:read` including `audit:read`, no writes |

Roles are data, not code — editable in the Roles & Permissions screen with dual-control.

---

## 6. Audit logging

Every **mutation** flows through `admin-gateway`, which — inside the same request, before returning success — writes an **append-only** event to `audit-svc`. If the audit write fails, the mutation is rolled back (the action is never considered done without its audit record).

**Event schema**
```jsonc
{
  "id": "aud_01H…",
  "ts": "2026-07-29T14:03:22.184Z",
  "actor": { "adminId": "adm_…", "email": "…", "roleUsed": "Moderator", "ip": "…", "ua": "…" },
  "action": "moderation.sanction.ban",          // domain.resource.action
  "target": { "type": "player", "id": "ply_…" },
  "scope":  { "region": "KR", "env": "PROD" },
  "before": { "status": "active" },              // diff, redacted for PII where needed
  "after":  { "status": "banned", "days": 30, "reason": "cheating" },
  "context": { "reportId": "rep_…", "note": "…" },
  "twoFactorVerified": true,
  "approval": { "required": false, "approverId": null },
  "correlationId": "req_…"
}
```

**Guarantees**
- **Append-only / tamper-evident:** `audit-svc` rejects updates/deletes; records are hash-chained (each event carries the prior event's hash) so gaps or edits are detectable.
- **Complete diffs:** before/after captured by the gateway so a reviewer can see exactly what changed.
- **Attribution:** actor, the *specific role* exercised, IP/UA, and whether a 2FA step-up backed the action.
- **Dual-control trail:** for dual-control actions, both requester and approver events are linked.
- **Retention & export:** long-retention store; Analyst/Auditor roles search and export (async signed CSV). The UI can only read the audit log — never write it.
- **Streamed to SIEM:** audit events also fan out to the security SIEM via Kafka for out-of-band monitoring.

---

## 7. Cross-cutting UX & non-functional requirements

- **Performance:** server-side pagination/filter/sort everywhere; virtualized tables; charts fed pre-aggregated datasets from `analytics-svc` (no client-side crunching of raw events). Route-level code splitting per section.
- **Realtime:** one multiplexed WS connection; `useLiveChannel(topic)` subscribes/unsubscribes per mounted screen; messages patch the TanStack Query cache.
- **Optimism policy:** optimistic for low-risk edits (draft toggles, notes); pessimistic (await server) for money, bans, publishes, payouts.
- **Empty/error/loading:** every screen ships skeletons, empty states, and typed error states; 403 screens for permission gaps; global error boundary → Sentry.
- **Accessibility:** WCAG 2.1 AA — full keyboard nav, focus management in modals/drawers, ARIA on the data grid, contrast checked in both themes.
- **Environments:** the top-bar env switcher (STAGING/PROD) is a first-class, color-coded safety signal; PROD writes carry an extra visual warning.
- **Localization:** all operator-facing and all player-facing (push, macros, warnings) strings are localized; player-facing content editors are multi-locale with fallback warnings.

---

## 8. Suggested build order

Ordered to unblock the highest-value operations first and to align with the platform roadmap (services land ~in this order too). MSW mocks each screen against the `packages/contracts` types so UI can start before a service is live.

| Phase | Deliverable | Why first / depends on |
| --- | --- | --- |
| **0. Foundation** | App shell: routing, theme/tokens, sidebar/topbar IA, SSO login + 2FA, RBAC guard (route + control gating), Zustand session store, TanStack Query + WS client, MSW harness, design-system setup, error boundary, i18n. | Everything else mounts on this. No screen ships without RBAC gating working. |
| **1. Players + Moderation** | Player Search, Player Detail, Inventory (read first), Reports Queue, Moderation Queue, Sanction History, Support Tickets. | Day-one operational need: the second there are players, T&S and Support must function. Depends on `account/profile/inventory/moderation/report/support` svcs. |
| **2. Overview + Analytics** | Live Ops Board, Server Health, Revenue, Analytics (DAU/retention/funnel), Live Matches, Server Fleet, Logs. | Visibility/monitoring; mostly read-only so lower risk, high leverage. Depends on `analytics/match/log` svcs + WS. |
| **3. Economy** | Store Editor, Cosmetics editors, Bundles, Loot Tables & Drop Rates (+ simulator), Currency & Ledger, Inventory *write* (grants/adjust). | Revenue + fairness surface; introduces dual-control + publish flows. Depends on `catalog/economy` svcs. |
| **4. LiveOps + Engagement** | Seasons, Battle Pass, Events, Daily Rewards, Missions, unified Schedule, Push & Inbox Campaigns. | Drives retention/monetization cadence; builds on Economy (rewards reference catalog). Depends on `liveops/notify`. |
| **5. Community + Content** | Clan Manager, Tournament Manager (+ payouts), Maps & Spawns, NPC/Bot Management. | Later-lifecycle features; content publishing + payouts reuse the dual-control machinery. Depends on `clan/tournament/world/bot`. |
| **6. Admin hardening** | Users, Roles & Permissions (full editor), Audit Log viewer, 2FA & Sessions, Feature Flags, Settings, dual-control approval flows, export pipeline. | Governance layer matured once real roles/usage exist; audit viewer polished last though audit *writing* exists from Phase 0. |

Phases 0 and 1 are the MVP that makes the game operable in soft-launch; 2–6 layer on scale, monetization, and governance.

---

## 9. Directory sketch (`phoenix/admin/`)

```
admin/
  src/
    app/                # router, providers (Query, theme, i18n), guards
    shared/
      api/              # generated clients from packages/contracts, ws client
      rbac/             # <Can>, useCan(), route guards
      ui/               # theme.ts, primitives, DataTable wrapper, chart kit
      hooks/            # useLiveChannel, useConfirm, useStepUp2FA
    features/
      overview/  players/  economy/  liveops/  engagement/
      community/  content/  ops/  trustsafety/  admin/
    mocks/              # MSW handlers per feature
  tests/                # vitest + playwright (incl. rbac matrix)
```

Each `features/*` folder owns its routes, screens, queries/mutations, and mock handlers — so a team can build a section end-to-end in isolation.
