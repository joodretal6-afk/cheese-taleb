# Project Phoenix — Backend Architecture

> **Status:** Living document — v1.0
> **Owner:** Lead Backend Engineering
> **Scope:** Server-side platform for the Phoenix mobile Battle Royale. This document defines the microservice topology, ownership boundaries, communication contracts, cross-cutting concerns, build order, and the NestJS monorepo layout.

---

## 1. Architectural Principles

1. **Database-per-service.** No service reads another service's tables. Cross-service data is obtained via APIs or via events. Shared reference data is replicated through Kafka read-models, never via cross-schema joins.
2. **Sync for reads-in-the-request-path, async for side effects.** If a caller is blocked waiting for an answer to continue, it is a synchronous call (gRPC internally, REST/GraphQL at the edge). If the caller only needs to announce that something happened, it is a Kafka event.
3. **gRPC is the internal default.** Service-to-service RPC is gRPC (HTTP/2, protobuf, strongly typed, low latency). REST is exposed only at the API Gateway / BFF edge for clients. GraphQL is a single read-aggregation layer for the game client's profile/home screens. WebSocket is used for realtime push (matchmaking status, notifications, presence).
4. **Events are facts, not commands.** Kafka event names are past-tense (`match.completed`, `payment.captured`). A producer never assumes a specific consumer exists.
5. **Idempotency everywhere.** Every mutating API and every event consumer accepts an idempotency key or dedupes on an event id. Kafka delivery is at-least-once.
6. **The game server fleet is a client, not a service.** Authoritative match simulation runs on dedicated game servers (out of scope here). They talk to the platform through Matchmaking (session allocation) and emit `match.completed` events consumed by Ranking, Inventory, Analytics, etc.

---

## 2. Service Catalogue (high-level)

| # | Service | Primary datastore | Sync surface | Async role |
|---|---------|-------------------|--------------|------------|
| 1 | Auth | PostgreSQL + Redis | gRPC + REST (via GW) | produces `user.registered`, `user.banned` |
| 2 | Matchmaking | Redis (queues) + PostgreSQL | gRPC + WS | produces `match.created`; consumes `player.rating.updated` |
| 3 | Inventory | PostgreSQL | gRPC | consumes `match.completed`, `store.item.purchased`; produces `inventory.item.granted` |
| 4 | Player Profile | PostgreSQL + Redis | gRPC + GraphQL | consumes `match.completed`, `user.registered` |
| 5 | Ranking | PostgreSQL + Redis (sorted sets) | gRPC | consumes `match.completed`; produces `player.rating.updated` |
| 6 | Clan | PostgreSQL | gRPC + REST | produces `clan.member.joined`, `clan.disbanded` |
| 7 | Store | PostgreSQL | gRPC + REST | produces `store.item.purchased`; consumes `payment.captured` |
| 8 | Payment | PostgreSQL | gRPC + REST (webhooks) | produces `payment.captured`, `payment.refunded` |
| 9 | Analytics | Kafka → ClickHouse | gRPC (ingest) | consumes ~all events (fan-in sink) |
| 10 | Notification | PostgreSQL + Redis | gRPC + WS | consumes many events; fan-out push/email |
| 11 | Replay | PostgreSQL (metadata) + S3/object store | gRPC + REST | consumes `match.completed` |
| 12 | Voice Chat | Redis (session state) | gRPC + WS (SFU signaling) | consumes `match.created` |
| 13 | Friends | PostgreSQL + Redis (presence) | gRPC + WS | produces `friend.request.accepted`; consumes `user.registered` |

---

## 3. Service Specifications

Each spec lists: **Responsibility**, **Owned data**, **Key APIs**, **Sync/async boundary**, and **Dependencies** (who it talks to and how).

### 3.1 Auth Service

**Responsibility:** Identity, credentials, session/token lifecycle, OAuth (Apple, Google, Facebook, guest), device binding, ban enforcement, RBAC/scopes. The root of trust: every other service validates JWTs signed by Auth (via shared JWKS), it does not call Auth per request.

**Owned data:** `users` (id, email, oauth_subjects, status), `credentials` (argon2 hashes), `refresh_tokens`, `devices`, `bans`, `roles`, `oauth_providers`. Signing keys in a KMS; public JWKS cached in Redis.

**Key APIs**

| Method | Endpoint / RPC | Purpose |
|--------|----------------|---------|
| REST POST | `/v1/auth/register` | Email/password or guest registration |
| REST POST | `/v1/auth/login` | Credential login → access + refresh token |
| REST POST | `/v1/auth/oauth/:provider` | OAuth code exchange → tokens |
| REST POST | `/v1/auth/refresh` | Rotate refresh token → new access token |
| REST POST | `/v1/auth/logout` | Revoke refresh token / device session |
| gRPC | `Auth.ValidateToken` | (Optional) introspection for opaque tokens; JWT path is local-verify |
| gRPC | `Auth.GetUser` | Fetch identity by id for other services |
| gRPC | `Auth.CheckBan` | Authoritative ban check for gameplay entry |
| REST GET | `/.well-known/jwks.json` | Public signing keys for local JWT verification |

**Sync vs async:** Login/refresh/validation are **synchronous** (request path). Downstream propagation of identity lifecycle is **async**.

**Dependencies / protocols**
- Produces Kafka: `user.registered`, `user.banned`, `user.deleted`.
- No synchronous outbound calls to other business services (keeps it the trust root, avoids cycles).

---

### 3.2 Matchmaking Service

**Responsibility:** Ticket-based matchmaking. Accepts queue requests, groups players by mode/region/skill (MMR from Ranking), forms matches, allocates a game server session, and pushes status to clients over WebSocket. Handles party/squad queueing, backfill, and cancellation.

**Owned data:** In Redis: per-mode/region queues (sorted by MMR + wait time), active tickets, party composition. In PostgreSQL: `matches` (id, mode, region, roster, server_alloc, state), `match_history_index`.

**Key APIs**

| Method | Endpoint / RPC | Purpose |
|--------|----------------|---------|
| gRPC | `Matchmaking.EnqueueTicket` | Join queue (solo/duo/squad) |
| gRPC | `Matchmaking.CancelTicket` | Leave queue |
| gRPC | `Matchmaking.GetTicketStatus` | Poll ticket state |
| WS | `ws /v1/mm/stream` | Push `SEARCHING → MATCH_FOUND → SERVER_READY` to client |
| gRPC | `Matchmaking.AllocateBackfill` | Game server requests a replacement player |
| gRPC (in) | `Matchmaking.ReportMatchState` | Game server reports lifecycle updates |

**Sync vs async:** Enqueue/cancel/status are **synchronous** gRPC. Match formation runs in an **internal loop** (not request-scoped). Result publication is **async** (`match.created`). MMR reads come from a **locally maintained read-model** fed by `player.rating.updated` (not a per-ticket gRPC call, to keep the matcher hot-path cheap).

**Dependencies / protocols**
- Consumes Kafka: `player.rating.updated` (maintains MMR read-model), `user.banned` (evict from queue).
- Produces Kafka: `match.created` (roster + server allocation), `matchmaking.ticket.expired`.
- gRPC → Fleet/Session allocator (game server orchestrator) to reserve a server.
- WS → client.

---

### 3.3 Inventory Service

**Responsibility:** Ownership ledger of everything a player possesses — skins, weapons cosmetics, currencies (soft/hard), battle-pass tiers, consumables, crafting materials. Grants, consumes, and transfers items with a fully auditable ledger. Source of truth for "does the player own X".

**Owned data:** `items_catalog_cache` (replicated from Store), `player_inventory` (player_id, item_id, qty, acquired_at, source), `currency_balances`, `inventory_ledger` (append-only, every mutation with reason + idempotency key), `entitlements`.

**Key APIs**

| Method | Endpoint / RPC | Purpose |
|--------|----------------|---------|
| gRPC | `Inventory.GetInventory` | Full inventory for a player |
| gRPC | `Inventory.GrantItems` | Idempotent grant (rewards, purchases) |
| gRPC | `Inventory.ConsumeItem` | Spend a consumable / currency |
| gRPC | `Inventory.CheckOwnership` | Fast "owns item?" for equip validation |
| gRPC | `Inventory.GetBalances` | Currency balances |
| gRPC | `Inventory.TransferCurrency` | Internal transfer with ledger entry |

**Sync vs async:** Reads/grants callable **synchronously** by Store and game flow. But the primary grant path is **event-driven**: Inventory consumes `store.item.purchased` and `match.completed` and grants idempotently, so a purchase remains consistent even if the synchronous caller times out.

**Dependencies / protocols**
- Consumes Kafka: `store.item.purchased`, `match.completed` (match rewards), `battlepass.tier.unlocked`.
- Produces Kafka: `inventory.item.granted`, `inventory.currency.spent`.
- Consumes Kafka: `store.catalog.updated` → refreshes `items_catalog_cache` read-model.

---

### 3.4 Player Profile Service

**Responsibility:** The player-facing aggregate: display name, avatar, level/XP, career stats (kills, wins, K/D, matches played), loadout config, title/badge selection, privacy settings. Acts as the read-model owner for the home/profile screens and backs the GraphQL layer.

**Owned data:** `profiles` (player_id, display_name, avatar_id, level, xp, country), `career_stats`, `loadouts`, `equipped_cosmetics`, `privacy_settings`. Hot profiles cached in Redis.

**Key APIs**

| Method | Endpoint / RPC | Purpose |
|--------|----------------|---------|
| gRPC | `Profile.GetProfile` | Full profile by player id |
| gRPC | `Profile.GetProfilesBatch` | Batch fetch (lobby/leaderboard hydration) |
| gRPC | `Profile.UpdateProfile` | Change display name / avatar |
| gRPC | `Profile.SetLoadout` | Save a loadout (validated vs Inventory ownership) |
| GraphQL | `query player(id)` | Client-facing aggregate (profile + rank + clan + friends count) |
| gRPC | `Profile.SearchByName` | Name search for friend invites |

**Sync vs async:** Reads are **synchronous**. Stat updates are **async** — Profile consumes `match.completed` and recomputes career stats and XP/level in the background. `SetLoadout` synchronously calls `Inventory.CheckOwnership` to reject unowned cosmetics.

**Dependencies / protocols**
- Consumes Kafka: `match.completed` (stat/XP updates), `user.registered` (create profile), `player.rating.updated` (denormalize rank into profile card).
- gRPC → Inventory (`CheckOwnership` on loadout save).
- GraphQL resolver fans out gRPC → Ranking, Clan, Friends to build the aggregate.

---

### 3.5 Ranking Service

**Responsibility:** Skill rating (MMR), ranked tiers/divisions (Bronze→Champion), seasonal ladders, and leaderboards (global, regional, friends, clan). Computes rating deltas from match results.

**Owned data:** `player_ratings` (player_id, mode, mmr, tier, division, rd/volatility), `season_config`, `rating_history`. Leaderboards in Redis **sorted sets** (`lb:global:{season}:{mode}`), rebuilt/backed by PostgreSQL snapshots.

**Key APIs**

| Method | Endpoint / RPC | Purpose |
|--------|----------------|---------|
| gRPC | `Ranking.GetRating` | Current MMR/tier for a player+mode |
| gRPC | `Ranking.GetRatingsBatch` | Batch for lobby/matchmaking hydration |
| gRPC | `Ranking.GetLeaderboard` | Paginated leaderboard slice |
| gRPC | `Ranking.GetRankAround` | "Your neighbors" window on the ladder |
| gRPC | `Ranking.GetSeasonInfo` | Active season + rewards config |

**Sync vs async:** Leaderboard/rating reads are **synchronous** (Redis-backed, fast). Rating computation is **async**: consumes `match.completed`, applies a Glicko-2/Elo-hybrid update, persists, updates sorted sets, then emits `player.rating.updated`.

**Dependencies / protocols**
- Consumes Kafka: `match.completed`.
- Produces Kafka: `player.rating.updated` (Matchmaking + Profile consume it), `ranking.season.rolled`.

---

### 3.6 Clan Service

**Responsibility:** Clans/guilds — creation, membership, roles (leader/officer/member), invitations, join requests, clan tag, clan XP/level, and clan-scoped leaderboard membership. Enforces size caps and permission rules.

**Owned data:** `clans` (id, tag, name, level, xp, region), `clan_members` (clan_id, player_id, role, joined_at), `clan_invites`, `clan_join_requests`, `clan_bans`.

**Key APIs**

| Method | Endpoint / RPC | Purpose |
|--------|----------------|---------|
| REST POST | `/v1/clans` | Create clan |
| REST GET | `/v1/clans/:id` | Clan detail + roster |
| gRPC | `Clan.GetClanForPlayer` | Which clan a player is in (Profile/GraphQL) |
| REST POST | `/v1/clans/:id/invites` | Invite a player |
| REST POST | `/v1/clans/:id/join-requests` | Request to join |
| REST POST | `/v1/clans/:id/members/:pid/role` | Promote/demote |
| REST DELETE | `/v1/clans/:id/members/:pid` | Kick / leave |

**Sync vs async:** Membership mutations are **synchronous** (immediate consistency the user expects). Notifications and clan-XP aggregation are **async**.

**Dependencies / protocols**
- Produces Kafka: `clan.member.joined`, `clan.member.left`, `clan.disbanded`, `clan.invite.sent`.
- Consumes Kafka: `match.completed` (attribute clan XP), `user.banned` (auto-remove).
- gRPC → Profile (`GetProfilesBatch`) to hydrate roster display names; Notification consumes clan events for pushes.

---

### 3.7 Store Service

**Responsibility:** Commerce catalog and checkout orchestration — item catalog, pricing, offers/bundles, battle pass definitions, featured/rotating shop, and the checkout state machine that ties a purchase intent to a Payment and to an Inventory grant.

**Owned data:** `catalog_items` (id, type, prices, availability window), `bundles`, `battlepass_seasons`, `shop_rotations`, `orders` (order_id, player_id, line_items, state: PENDING→PAID→FULFILLED→FAILED), `offers`.

**Key APIs**

| Method | Endpoint / RPC | Purpose |
|--------|----------------|---------|
| REST GET | `/v1/store/catalog` | Current catalog (region/segment aware) |
| REST GET | `/v1/store/shop` | Rotating featured shop |
| REST POST | `/v1/store/orders` | Create purchase intent (soft currency or real money) |
| REST GET | `/v1/store/orders/:id` | Order state |
| gRPC | `Store.GetCatalogItem` | Item metadata for Inventory/others |
| gRPC | `Store.ValidateEntitlement` | Confirm a battle-pass/offer eligibility |

**Sync vs async:** Order **creation** is synchronous (returns an intent + payment handoff). **Fulfillment is async and event-driven** — the checkout saga:
1. Create `order` (PENDING).
2. Soft-currency path → sync gRPC `Inventory.ConsumeItem` then emit `store.item.purchased`.
3. Real-money path → hand to Payment; on `payment.captured` (consumed), transition PAID and emit `store.item.purchased`; Inventory grants; on `inventory.item.granted` transition FULFILLED. Compensate to FAILED + `payment.refunded` on grant failure.

**Dependencies / protocols**
- gRPC → Payment (`CreateCharge`), Inventory (`ConsumeItem` for currency spend).
- Consumes Kafka: `payment.captured`, `payment.refunded`, `inventory.item.granted`.
- Produces Kafka: `store.item.purchased`, `store.catalog.updated`, `battlepass.tier.unlocked`.

---

### 3.8 Payment Service

**Responsibility:** Real-money payment processing and reconciliation. Integrates App Store / Play Store receipt validation and PSPs (Stripe/Adyen). Owns the money-side ledger, refunds, chargebacks, and idempotent capture. It is the **only** service that touches PSP credentials and PCI-adjacent data.

**Owned data:** `charges` (charge_id, order_ref, amount, currency, psp, status), `payment_ledger` (double-entry, append-only), `receipts` (store receipts + validation result), `refunds`, `webhook_events` (dedupe).

**Key APIs**

| Method | Endpoint / RPC | Purpose |
|--------|----------------|---------|
| gRPC | `Payment.CreateCharge` | Initiate a charge for an order |
| gRPC | `Payment.ValidateReceipt` | Verify App/Play Store receipt |
| gRPC | `Payment.GetCharge` | Charge status |
| gRPC | `Payment.RefundCharge` | Issue refund |
| REST POST | `/v1/payments/webhooks/:psp` | PSP async webhook (signature-verified) |

**Sync vs async:** `CreateCharge` returns a **synchronous** intent (client-secret / redirect), but authoritative capture arrives **async via PSP webhook**. On webhook, Payment writes ledger and emits `payment.captured`. This decouples fulfillment from client connectivity.

**Dependencies / protocols**
- Produces Kafka: `payment.captured`, `payment.failed`, `payment.refunded`, `payment.chargeback.received`.
- No outbound business-service calls — it reacts to Store's gRPC and PSP webhooks, then emits facts. Analytics consumes all payment events for revenue reporting.

---

### 3.9 Analytics Service

**Responsibility:** Telemetry sink and product/behavioral analytics. Fan-in consumer of nearly every domain event plus a high-volume client-telemetry ingest path. Writes to a columnar store (ClickHouse) for BI, funnels, retention, A/B test readouts, and anti-cheat signals.

**Owned data:** ClickHouse tables (`events_raw`, `match_facts`, `revenue_facts`, `session_facts`), plus a small PostgreSQL for experiment/config metadata. No OLTP writes back to other services.

**Key APIs**

| Method | Endpoint / RPC | Purpose |
|--------|----------------|---------|
| gRPC | `Analytics.IngestClientEvents` | Batched client telemetry (streamed) |
| gRPC | `Analytics.GetExperimentAssignment` | A/B bucket for a player |
| REST GET | `/v1/analytics/experiments` | Internal dashboards (admin-scoped) |

**Sync vs async:** Ingestion is **async / streaming**. It is a pure **consumer** of the Kafka bus (`match.completed`, `payment.captured`, `user.registered`, `store.item.purchased`, `player.rating.updated`, etc.) via a broad subscription, batching into ClickHouse. Client-side events arrive over a streaming gRPC call from the BFF.

**Dependencies / protocols**
- Consumes Kafka: broad topic set (fan-in).
- Produces Kafka: `analytics.anticheat.flag` (optional signal back to a moderation pipeline).

---

### 3.10 Notification Service

**Responsibility:** Unified notification fan-out — mobile push (APNs/FCM), in-app inbox, email, and realtime WebSocket toasts. Owns templates, user notification preferences, delivery scheduling, and dedupe/throttling.

**Owned data:** `device_tokens` (player_id, platform, token), `notification_prefs`, `inbox_messages`, `templates`, `delivery_log`, `scheduled_notifications`.

**Key APIs**

| Method | Endpoint / RPC | Purpose |
|--------|----------------|---------|
| gRPC | `Notification.Send` | Send a templated notification (internal) |
| gRPC | `Notification.RegisterDevice` | Register APNs/FCM token |
| REST GET | `/v1/notifications/inbox` | Player inbox list |
| REST POST | `/v1/notifications/inbox/:id/read` | Mark read |
| REST PUT | `/v1/notifications/prefs` | Update preferences |
| WS | `ws /v1/notify/stream` | Realtime push to connected client |

**Sync vs async:** Mostly **async** — Notification consumes domain events and decides what to deliver. `Notification.Send` gRPC exists for deliberate transactional sends. Actual delivery to APNs/FCM/email is queued and retried.

**Dependencies / protocols**
- Consumes Kafka: `friend.request.accepted`, `clan.member.joined`, `clan.invite.sent`, `store.item.purchased`, `match.completed` (results summary), `ranking.season.rolled`, `payment.refunded`.
- gRPC → Profile (`GetProfilesBatch`) to render "X invited you".
- WS → client; external APNs/FCM/SMTP.

---

### 3.11 Replay Service

**Responsibility:** Match replay/highlight storage and retrieval. Stores compact input-stream replay files (uploaded by game servers), indexes them by match/player, generates highlight metadata, and serves signed download URLs. Backs "watch replay" and killcam features.

**Owned data:** PostgreSQL `replays` (match_id, players[], size, duration, storage_key, ttl), `highlights` (replay_id, timestamp, type, player_id). Blobs in S3-compatible object storage.

**Key APIs**

| Method | Endpoint / RPC | Purpose |
|--------|----------------|---------|
| gRPC | `Replay.RegisterReplay` | Game server registers an uploaded replay |
| REST POST | `/v1/replays/upload-url` | Presigned upload URL for game server |
| REST GET | `/v1/replays/:matchId` | Replay metadata + signed download |
| REST GET | `/v1/replays/player/:pid` | Player's recent replays |
| gRPC | `Replay.GetHighlights` | Highlight markers for a match |

**Sync vs async:** Metadata reads/writes are **synchronous**. Replay registration is triggered **async** by `match.completed` (creates the expected-replay record + presigned upload slot); highlight extraction runs as a background job. Old replays expire via TTL sweep.

**Dependencies / protocols**
- Consumes Kafka: `match.completed` (create replay record, allocate upload slot).
- Produces Kafka: `replay.available` (Notification may push "your replay is ready").
- Object storage for blobs; presigned URLs so blobs never transit the service.

---

### 3.12 Voice Chat Service

**Responsibility:** Realtime voice signaling and session control for parties and in-match teams. Manages voice room lifecycle, membership, mute/permission state, and coordinates with a media SFU (Selective Forwarding Unit). Signaling only — audio media flows through the SFU/media plane, not through this service.

**Owned data:** Redis: `voice_rooms` (room_id, members, sfu_node, mode), per-member mute/role state, tokens. Ephemeral by design; no long-term OLTP store beyond audit counters.

**Key APIs**

| Method | Endpoint / RPC | Purpose |
|--------|----------------|---------|
| gRPC | `Voice.CreateRoom` | Create a party/match voice room |
| gRPC | `Voice.JoinRoom` | Issue SFU credentials + join |
| WS | `ws /v1/voice/signal` | WebRTC signaling (SDP/ICE), mute events |
| gRPC | `Voice.SetMute` | Server-side mute / moderation |
| gRPC | `Voice.CloseRoom` | Tear down room |

**Sync vs async:** Room control is **synchronous** gRPC; signaling is **realtime WS**. Room creation for a match is triggered **async** by `match.created` (pre-provision the room so it exists when players load in).

**Dependencies / protocols**
- Consumes Kafka: `match.created` (pre-create match voice room), `user.banned` (evict).
- gRPC → SFU media node controller for allocation.
- WS → client for WebRTC signaling.

---

### 3.13 Friends Service

**Responsibility:** Social graph — friend requests, friend lists, blocks, presence (online/in-lobby/in-match), and recent-teammates suggestions. Feeds the friends leaderboard and party invites.

**Owned data:** PostgreSQL `friendships` (a_id, b_id, status), `friend_requests`, `blocks`, `recent_teammates`. Presence in Redis (`presence:{player_id}` with TTL heartbeat + pub/sub).

**Key APIs**

| Method | Endpoint / RPC | Purpose |
|--------|----------------|---------|
| gRPC | `Friends.GetFriends` | Friend list + presence |
| gRPC | `Friends.AreFriends` | Relationship check (party/voice authz) |
| REST POST | `/v1/friends/requests` | Send friend request |
| REST POST | `/v1/friends/requests/:id/accept` | Accept |
| REST DELETE | `/v1/friends/:pid` | Remove friend |
| REST POST | `/v1/friends/blocks` | Block a player |
| WS | `ws /v1/friends/presence` | Realtime presence updates |

**Sync vs async:** Graph mutations are **synchronous**. Presence is **realtime** (Redis pub/sub → WS). Friend-request notifications go out **async** via events.

**Dependencies / protocols**
- Consumes Kafka: `user.registered` (bootstrap), `match.completed` (populate recent-teammates), `user.banned`.
- Produces Kafka: `friend.request.accepted` (Notification consumes it).
- gRPC → Profile (`GetProfilesBatch`) for list hydration.

---

## 4. Service-to-Service Communication

### 4.1 Choosing a protocol

| Situation | Protocol | Why |
|-----------|----------|-----|
| Caller needs an answer to proceed (ownership check, rating lookup, profile fetch) | **gRPC** | Typed protobuf contracts, HTTP/2 multiplexing, low latency, code-gen clients, deadlines/cancellation |
| Client (mobile) → platform, request/response | **REST via API Gateway** | Universal client support, cacheable, simple auth headers |
| Client home/profile aggregate read | **GraphQL (BFF)** | One round trip, client selects fields, avoids over-fetch across Profile/Rank/Clan/Friends |
| Realtime server→client push | **WebSocket** | Matchmaking status, notifications, presence, voice signaling |
| "Something happened", multiple interested consumers, must not block producer | **Kafka event** | Decoupling, replay, at-least-once durability, fan-out |
| Bulk/analytics telemetry | **Kafka + streaming gRPC ingest** | Throughput, backpressure, columnar sink |

**Rule of thumb:** If removing the callee would make the caller unable to answer its own request *right now*, it's gRPC. If removing the callee would only mean "a side effect doesn't happen", it's Kafka.

### 4.2 gRPC conventions

- Contracts live in `packages/proto` (single source of truth). CI runs `buf lint` + `buf breaking`.
- Every RPC carries a **deadline** (default 300 ms internal; matchmaking hot-path 100 ms) and propagates trace context.
- Server-side interceptors: auth (service-identity mTLS + JWT passthrough), logging, metrics, retry budget.
- Idempotent RPCs marked; non-idempotent take an `idempotency_key` field.

### 4.3 Kafka topic catalogue

| Topic | Key | Producer | Main consumers |
|-------|-----|----------|----------------|
| `user.registered` | user_id | Auth | Profile, Friends, Inventory, Analytics |
| `user.banned` | user_id | Auth | Matchmaking, Friends, Clan, Voice, Analytics |
| `match.created` | match_id | Matchmaking | Voice, Analytics |
| `match.completed` | match_id | Game server (via Matchmaking ingest) | Ranking, Profile, Inventory, Clan, Replay, Friends, Analytics |
| `player.rating.updated` | player_id | Ranking | Matchmaking, Profile, Analytics |
| `store.item.purchased` | order_id | Store | Inventory, Notification, Analytics |
| `store.catalog.updated` | item_id | Store | Inventory, Analytics |
| `payment.captured` | charge_id | Payment | Store, Analytics |
| `payment.refunded` | charge_id | Payment | Store, Inventory, Notification, Analytics |
| `inventory.item.granted` | player_id | Inventory | Store, Notification, Analytics |
| `clan.member.joined` | clan_id | Clan | Notification, Analytics |
| `friend.request.accepted` | request_id | Friends | Notification, Analytics |
| `replay.available` | match_id | Replay | Notification |

**Topic conventions:** `<domain>.<entity>.<past-tense-event>`, 12–24 partitions keyed by aggregate id for ordering per entity, `compact` for state topics (catalog) and `delete` w/ 7–30d retention for event streams. A `.dlq` topic per consumer group for poison messages.

### 4.4 Event envelope

All events share an envelope so consumers can dedupe, trace, and version:

```json
{
  "event_id": "01J8Z5K3Q7...",          // ULID, used for consumer-side dedupe
  "event_type": "match.completed",
  "event_version": 2,
  "occurred_at": "2026-07-29T10:15:03.221Z",
  "producer": "matchmaking-svc@1.14.2",
  "trace_id": "4bf92f3577b34da6...",     // W3C traceparent for cross-service tracing
  "partition_key": "match_9f3a...",
  "data": { }                             // typed payload below
}
```

**Example payloads**

`match.completed`:

```json
{
  "match_id": "match_9f3a2c",
  "mode": "squad_br",
  "region": "eu-west",
  "duration_sec": 1187,
  "season_id": "s7",
  "placements": [
    { "player_id": "p_1001", "squad_id": "sq_a", "rank": 1, "kills": 7,
      "damage": 1420, "survival_sec": 1187, "xp_earned": 950,
      "currency_rewards": [{ "item_id": "cur_soft", "qty": 300 }] },
    { "player_id": "p_1002", "squad_id": "sq_b", "rank": 14, "kills": 1,
      "damage": 210, "survival_sec": 640, "xp_earned": 180, "currency_rewards": [] }
  ]
}
```

`payment.captured`:

```json
{
  "charge_id": "chg_77af",
  "order_ref": "ord_5521",
  "player_id": "p_1001",
  "amount_minor": 999,
  "currency": "USD",
  "psp": "stripe",
  "captured_at": "2026-07-29T10:14:59Z"
}
```

`store.item.purchased`:

```json
{
  "order_id": "ord_5521",
  "player_id": "p_1001",
  "payment_kind": "real_money",
  "line_items": [
    { "item_id": "skin_dragon_epic", "qty": 1 },
    { "item_id": "cur_hard", "qty": 500 }
  ],
  "idempotency_key": "grant_ord_5521"
}
```

---

## 5. Shared / Cross-Cutting Concerns

### 5.1 Configuration
- Central `@phoenix/config` package wrapping NestJS `ConfigModule` with a **Zod-validated schema** — the app fails fast on boot if a required var is missing.
- Layered: baked defaults → env vars → runtime secrets from Vault/K8s Secrets. No secrets in images or Git.
- Feature flags via a lightweight flag provider (`@phoenix/flags`) with per-environment overrides.

### 5.2 Logging
- `@phoenix/logging` — structured JSON via Pino, one logger factory for all services.
- Mandatory fields: `service`, `trace_id`, `span_id`, `player_id` (when present), `request_id`.
- No PII in logs (emails/tokens redacted by a serializer). Ship to Loki/ELK.

### 5.3 Tracing & Metrics
- **OpenTelemetry** SDK in `@phoenix/observability`: auto-instrument HTTP, gRPC, Kafka, PG, Redis. W3C `traceparent` propagated on gRPC metadata and inside the Kafka event envelope (`trace_id`).
- Metrics exported to Prometheus (`/metrics`), dashboards in Grafana. RED (Rate/Errors/Duration) per gRPC method + Kafka consumer lag.
- Traces to Tempo/Jaeger.

### 5.4 Health checks
- Every service exposes `/health/live` (process up) and `/health/ready` (deps reachable: PG, Redis, Kafka, downstream gRPC) via `@nestjs/terminus`.
- Kubernetes liveness/readiness probes bound to these. Readiness fails → pod pulled from rotation without restart loop.

### 5.5 API Gateway / BFF
- **Edge API Gateway** (Kong/Envoy or a thin NestJS gateway) terminates TLS, authenticates JWTs, applies rate limits, and routes REST → services.
- **Mobile BFF** (NestJS) hosts the GraphQL aggregation layer + WebSocket fan-in. It composes gRPC calls to Profile/Ranking/Clan/Friends into client-shaped responses and holds the client WS connection, subscribing to Notification/Matchmaking/Presence streams.
- Internal services are **not** internet-exposed; only the Gateway/BFF are.

### 5.6 Rate limiting & resilience
- **Edge:** per-IP + per-user token-bucket in the Gateway (Redis-backed) — e.g. login 5/min/IP, checkout 10/min/user.
- **Internal:** gRPC concurrency limits + retry budgets; **circuit breakers** (`@phoenix/resilience`, opossum-style) around cross-service gRPC; bulkheads per downstream.
- **Kafka:** consumer-side idempotency (dedupe on `event_id`), bounded retry → DLQ.

### 5.7 Security
- Service-to-service **mTLS** (SPIFFE/mesh) + short-lived service identity.
- End-user JWT (RS256) verified **locally** via cached JWKS; scopes/roles enforced by a shared `@phoenix/auth-guard`.
- Payment isolated in its own namespace/network policy; PSP secrets in a dedicated vault path.

---

## 6. Recommended Build Order

Order is driven by the dependency DAG: build the trust root and shared libraries first, then services that only depend on already-built pieces, then aggregators.

| Phase | Build | Depends on / reasoning |
|-------|-------|------------------------|
| **0** | `packages/*` (proto, config, logging, observability, kafka, auth-guard, testing) | Everything imports these. Lock gRPC/proto tooling and the event envelope first. |
| **1** | **Auth** | Trust root. Nothing works without identity + JWT/JWKS. No business deps. |
| **2** | **Player Profile** | Consumes `user.registered`; needed by nearly every screen. Depends only on Auth + Kafka. |
| **3** | **Inventory** | Ledger backbone for rewards and store. Depends on Auth; consumes events. Store/Profile need it. |
| **4** | **Ranking** | Consumes `match.completed`; produces `player.rating.updated` that Matchmaking needs. Build before Matchmaking. |
| **5** | **Matchmaking** | Needs Ranking's rating read-model and Auth ban checks; produces `match.created`. Core gameplay entry. |
| **6** | **Payment** then **Store** | Payment first (Store's checkout saga depends on `payment.captured`). Store also depends on Inventory (built) for grants. |
| **7** | **Friends**, **Clan** | Social layer; depend on Profile (hydration) + Auth. Independent of gameplay, parallelizable. |
| **8** | **Notification** | Consumes events from most services above — build once producers exist so it has real events to route. |
| **9** | **Replay**, **Voice Chat** | Consume `match.completed` / `match.created`; enhancements, not blockers for the core loop. |
| **10** | **Analytics** | Pure fan-in sink — build last so its broad subscription covers the finalized topic set; can also be stubbed early to capture events from day one. |
| **cross** | **API Gateway / BFF** | Stand up a skeleton in Phase 1 (routes Auth) and extend it each phase as services come online. |

**Vertical-slice milestone:** Phases 0–5 deliver the minimum playable loop — register → matchmake → play → rank up → see updated profile. Phases 6+ layer monetization, social, and richness.

---

## 7. NestJS Monorepo Structure

Single repo, managed with **pnpm workspaces + Nx** (or Turborepo). Each service is an independently deployable Nest application; shared code lives in versioned internal packages.

```
phoenix/
├─ docs/
│  └─ 01-backend-architecture.md
├─ package.json                 # pnpm workspace root, shared scripts
├─ pnpm-workspace.yaml
├─ nx.json                      # task graph, affected builds
├─ tsconfig.base.json           # path aliases: @phoenix/*
├─ buf.yaml / buf.gen.yaml      # proto lint + codegen
├─ docker-compose.dev.yml       # local PG, Redis, Kafka, minio
│
├─ packages/                    # shared, versioned internal libraries
│  ├─ proto/                    # .proto files + generated TS stubs (single source of truth)
│  │  ├─ src/auth/auth.proto
│  │  ├─ src/inventory/inventory.proto
│  │  ├─ src/ranking/ranking.proto
│  │  └─ generated/            # buf-generated clients & types
│  ├─ config/                  # @phoenix/config  (Zod-validated ConfigModule)
│  ├─ logging/                 # @phoenix/logging (Pino factory + redaction)
│  ├─ observability/           # @phoenix/observability (OTel, Prometheus, terminus)
│  ├─ kafka/                   # @phoenix/kafka (producer/consumer wrappers, envelope, dedupe, DLQ)
│  ├─ auth-guard/              # @phoenix/auth-guard (JWT verify, JWKS cache, scope decorators)
│  ├─ resilience/              # @phoenix/resilience (circuit breaker, retry budget, bulkhead)
│  ├─ grpc-common/             # @phoenix/grpc-common (interceptors, mTLS, deadlines, client factory)
│  ├─ domain-events/           # @phoenix/domain-events (typed event payload schemas + versions)
│  ├─ testing/                 # @phoenix/testing (test harness, containers, fixtures)
│  └─ types/                   # @phoenix/types (shared DTOs, enums, error codes)
│
├─ services/                    # one Nest app per microservice
│  ├─ auth/
│  │  ├─ src/
│  │  │  ├─ main.ts            # bootstraps HTTP + gRPC hybrid app
│  │  │  ├─ app.module.ts
│  │  │  ├─ modules/
│  │  │  │  ├─ credentials/    # controllers, service, repo, dto
│  │  │  │  ├─ tokens/         # JWT issue/rotate, JWKS
│  │  │  │  ├─ oauth/
│  │  │  │  └─ bans/
│  │  │  ├─ grpc/              # gRPC controllers implementing auth.proto
│  │  │  ├─ events/           # Kafka producers (user.registered, user.banned)
│  │  │  ├─ config/           # service-specific config schema
│  │  │  └─ health/
│  │  ├─ prisma/ (or migrations/)  # owned schema + migrations
│  │  ├─ test/
│  │  ├─ Dockerfile
│  │  └─ project.json         # Nx targets: build/test/lint/serve
│  ├─ matchmaking/            # (same internal shape)
│  ├─ inventory/
│  ├─ player-profile/
│  ├─ ranking/
│  ├─ clan/
│  ├─ store/
│  ├─ payment/
│  ├─ analytics/
│  ├─ notification/
│  ├─ replay/
│  ├─ voice-chat/
│  └─ friends/
│
├─ apps/                        # edge tier
│  ├─ api-gateway/             # REST edge: TLS, authn, rate limit, routing
│  └─ mobile-bff/              # GraphQL aggregation + WebSocket hub
│
├─ deploy/
│  ├─ helm/                    # per-service Helm charts
│  ├─ k8s/                     # base manifests, network policies
│  └─ kafka/                   # topic definitions (topic-as-code)
│
└─ tools/
   ├─ scripts/                 # codegen, migration runners, seeders
   └─ generators/              # Nx generators to scaffold a new service
```

**Per-service internal shape (convention):** `modules/` (feature modules: controller + service + repository + dto), `grpc/` (proto-bound controllers), `events/` (Kafka producers/consumers), `config/`, `health/`. Each service owns its migrations and never imports another service's source — only shared `packages/*`.

**Bootstrap pattern (`main.ts`):** each service starts a **hybrid Nest app** — an HTTP server (health/metrics, plus REST where the service exposes it) *and* a gRPC microservice transport bound to its `.proto`, *and* connects Kafka consumers. Example responsibilities: Auth = REST + gRPC + Kafka producer; Matchmaking = gRPC + WS + Kafka; Analytics = gRPC ingest + broad Kafka consumer.

---

## 8. Summary Diagram (textual)

```
                 ┌──────────────┐        ┌──────────────┐
   Mobile client │ API Gateway  │  REST  │  Mobile BFF  │ GraphQL/WS
        ───────► │ (authn,rate) │◄──────►│ (aggregate)  │◄──────► client
                 └──────┬───────┘        └──────┬───────┘
                        │ REST/gRPC             │ gRPC fan-out
        ┌───────────────┼───────────────────────┼───────────────┐
        ▼               ▼                        ▼               ▼
     [Auth]       [Matchmaking]            [Profile]        [Friends]
        │               │                     │  ▲             │
        │ user.*        │ match.created       │  │ ratings     │
        ▼ (Kafka)       ▼                     │  │             ▼
  ┌───────────────────────────── KAFKA BUS ──────────────────────────┐
  │ user.registered  match.completed  player.rating.updated          │
  │ store.item.purchased  payment.captured  inventory.item.granted   │
  └──┬─────────┬──────────┬──────────┬─────────┬─────────┬───────────┘
     ▼         ▼          ▼          ▼         ▼         ▼
 [Ranking] [Inventory] [Store]  [Payment] [Notification][Analytics]
                                                   +[Replay][Voice][Clan]
```

Synchronous gRPC/REST/GraphQL edges are request-path reads; the Kafka bus carries facts that drive all side effects.
