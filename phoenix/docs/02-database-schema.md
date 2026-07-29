# Project Phoenix — Database Schema (02)

Canonical relational schema for the Project Phoenix backend.

- **Primary store:** PostgreSQL 16 (normalized, 3NF where practical).
- **Ephemeral / cache store:** Redis 7 (sessions, matchmaking queues, live match state, rate limits, leaderboards).
- **Convention:** every service owns its own logical schema and its own tables. Cross-service reads happen over gRPC/REST or via Kafka events, **never** by one service writing another service's tables. Foreign keys shown below that cross a service boundary are *logical* (enforced in-app / by event) and are called out explicitly; same-service FKs are real database constraints.

### Global conventions

- All primary keys are `BIGINT GENERATED ALWAYS AS IDENTITY` unless a key must be externally shareable or non-enumerable, in which case `UUID` (`gen_random_uuid()` from `pgcrypto`) is used (e.g. `players.public_id`, idempotency keys).
- Money is stored as **minor units** (`BIGINT`, e.g. cents) plus an ISO-4217 `currency_code CHAR(3)`. Never `FLOAT`.
- Soft-money / hard-money game currencies are integer balances, never floats.
- All timestamps are `TIMESTAMPTZ`, stored UTC. `created_at` / `updated_at` on every mutable table; `updated_at` maintained by a shared trigger `set_updated_at()`.
- Enumerations that are stable are native PostgreSQL `ENUM` types; enumerations that LiveOps edits at runtime are lookup tables.
- Deletes are soft (`deleted_at TIMESTAMPTZ NULL`) on player-facing content; hard deletes only for GDPR erasure and truly ephemeral rows.

---

## 1. Service ownership map

| Service | Schema | Owns tables |
| --- | --- | --- |
| **Auth** | `auth` | `players`, `player_credentials`, `player_oauth`, `sessions`(Redis-primary, PG audit), `bans`, `ban_appeals` |
| **Profile** | `profile` | `profiles`, `player_settings`, `friends`, `friend_requests`, `blocks`, `guilds`, `guild_members`, `guild_invites` |
| **Inventory** | `inventory` | `items`(catalog), `weapons`, `attachments`, `skins`, `weapon_attachment_compat`, `player_inventory`, `loadouts`, `loadout_slots` |
| **Match** | `match` | `maps`, `game_modes`, `matches`, `match_participants`, `match_events`, `player_statistics`, `player_mode_statistics` |
| **Ranking** | `ranking` | `seasons`, `ranks`, `player_rank_progress`, `leaderboard_snapshots` |
| **Store** | `store` | `store_items`, `store_categories`, `store_item_prices`, `bundles`, `bundle_items` |
| **Payments** | `payments` | `payment_methods`, `payments`, `purchases`, `purchase_lines`, `wallet_accounts`, `wallet_ledger`, `refunds` |
| **BattlePass** | `battlepass` | `battle_passes`, `battle_pass_tiers`, `battle_pass_rewards`, `player_battle_pass`, `battle_pass_progress`, `missions`, `mission_objectives`, `player_missions`, `player_mission_progress` |
| **Rewards/Loot** | `rewards` | `rewards`, `reward_grants`, `loot_tables`, `loot_table_entries`, `loot_drops` |
| **Notification** | `notify` | `notifications`, `notification_templates`, `device_tokens` |
| **Moderation** | `moderation` | `reports`, `report_evidence`, `moderation_actions` |
| **Platform/Audit** | `platform` | `audit_logs`, `event_logs`, `idempotency_keys`, `outbox` |

### What lives in Redis (not Postgres)

| Concern | Redis structure | Notes |
| --- | --- | --- |
| Live session / JWT refresh allowlist | `sess:{sessionId}` hash, TTL | Postgres keeps only an append-only audit of logins. |
| Matchmaking queue | `mm:{mode}:{region}` sorted set (score = MMR/wait) | Ephemeral; the durable record is the `matches` row created at lock-in. |
| Live match state (positions, alive count, ring) | `match:{id}:*` hashes/streams, short TTL | Authoritative during play on the game server; only the **result** is persisted to `matches`/`match_participants`. |
| Realtime leaderboards | `lb:{season}:{mode}` sorted set | Periodically snapshotted into `leaderboard_snapshots`. |
| Presence / online status | `presence:{playerId}` string, TTL | Friends "online now" reads Redis, not `profiles`. |
| Rate limits & anti-abuse counters | `rl:*` counters | — |
| Store / config hot cache | `cache:store:*` | Read-through cache of `store_items`. |
| Idempotency short-window | `idem:{key}` | Backed by durable `platform.idempotency_keys` for the long window. |

---

## 2. Entity list & relationships

### Players & Auth
- **players** 1—1 **profiles** (Profile svc; logical FK on `player_id`).
- **players** 1—1 **player_credentials** (password/hash) — optional (OAuth-only accounts have none).
- **players** 1—N **player_oauth** (google/apple/etc.).
- **players** 1—N **bans**; **bans** 1—N **ban_appeals**.

### Social
- **players** M—N **players** via **friends** (accepted, symmetric join table).
- **friend_requests**: directed edges pending acceptance.
- **blocks**: directed block edges.
- **guilds** 1—N **guild_members** (a player is in at most one guild via partial unique index); **guilds** 1—N **guild_invites**.

### Inventory & items
- **items** is the abstract catalog root (1—1 specialization to **weapons**, **attachments**, or **skins** via shared PK — class-table inheritance).
- **weapons** M—N **attachments** via **weapon_attachment_compat**.
- **players** M—N **items** via **player_inventory** (owned instances).
- **players** 1—N **loadouts**; **loadouts** 1—N **loadout_slots** (each slot references an owned inventory row).

### Matches & stats
- **maps** 1—N **matches**; **game_modes** 1—N **matches**.
- **matches** 1—N **match_participants** (M—N players↔matches resolved here).
- **matches** 1—N **match_events** (kills, revives…).
- **players** 1—1 **player_statistics** (lifetime aggregate) and 1—N **player_mode_statistics** (per mode/season).

### Ranking
- **seasons** 1—N **ranks**; **players** 1—N **player_rank_progress** (per season).
- **leaderboard_snapshots** materialize Redis leaderboards.

### Store / Payments / Wallet
- **store_categories** 1—N **store_items**; **store_items** 1—N **store_item_prices** (per currency/region).
- **bundles** M—N **store_items** via **bundle_items**.
- **players** 1—N **payments** 1—N **purchases**; **purchases** 1—N **purchase_lines**.
- **players** 1—1 **wallet_accounts** per currency; **wallet_accounts** 1—N **wallet_ledger** (double-entry style, immutable).
- **payments** 1—N **refunds**.

### Battle Pass, Missions, Rewards, Loot
- **seasons** 1—1 **battle_passes** (per season); **battle_passes** 1—N **battle_pass_tiers**; tiers 1—N **battle_pass_rewards**.
- **players** 1—1 **player_battle_pass** (per pass) with 1—1 **battle_pass_progress**.
- **battle_passes** 1—N **missions**; **missions** 1—N **mission_objectives**; **players** 1—N **player_missions** 1—N **player_mission_progress**.
- **rewards** is the reward definition; **reward_grants** is the ledger of what was granted to whom.
- **loot_tables** 1—N **loot_table_entries** (weighted); **loot_drops** logs rolls (audit + drop-rate transparency).

### Notifications / Moderation / Logs
- **players** 1—N **notifications**; **notification_templates** 1—N **notifications**; **players** 1—N **device_tokens**.
- **players** file **reports** against **players**; **reports** 1—N **report_evidence**; **reports** 1—N **moderation_actions**.
- **audit_logs** / **event_logs** are append-only, partitioned by month.

---

## 3. PostgreSQL DDL

### 3.0 Extensions, shared helpers, enums

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email/username

-- Schemas (one per service)
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS profile;
CREATE SCHEMA IF NOT EXISTS inventory;
CREATE SCHEMA IF NOT EXISTS match;
CREATE SCHEMA IF NOT EXISTS ranking;
CREATE SCHEMA IF NOT EXISTS store;
CREATE SCHEMA IF NOT EXISTS payments;
CREATE SCHEMA IF NOT EXISTS battlepass;
CREATE SCHEMA IF NOT EXISTS rewards;
CREATE SCHEMA IF NOT EXISTS notify;
CREATE SCHEMA IF NOT EXISTS moderation;
CREATE SCHEMA IF NOT EXISTS platform;

-- Shared updated_at trigger
CREATE OR REPLACE FUNCTION platform.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Enumerated types (stable domains only)
CREATE TYPE auth.account_status   AS ENUM ('active','suspended','banned','deleted','pending_verification');
CREATE TYPE auth.platform_type    AS ENUM ('ios','android','windows','other');
CREATE TYPE inventory.rarity      AS ENUM ('common','uncommon','rare','epic','legendary','mythic');
CREATE TYPE inventory.item_kind   AS ENUM ('weapon','attachment','skin','emote','currency','crate','consumable');
CREATE TYPE inventory.acquire_src AS ENUM ('purchase','battlepass','mission','loot','gift','admin_grant','starter');
CREATE TYPE match.match_state     AS ENUM ('created','in_progress','completed','aborted','cancelled');
CREATE TYPE match.participant_result AS ENUM ('win','loss','abandoned','disconnected');
CREATE TYPE store.currency_kind   AS ENUM ('real','soft','hard');  -- fiat vs in-game currencies
CREATE TYPE payments.txn_status   AS ENUM ('pending','authorized','captured','failed','refunded','partially_refunded','chargeback');
CREATE TYPE battlepass.track_type AS ENUM ('free','premium');
CREATE TYPE moderation.report_status AS ENUM ('open','triaging','actioned','dismissed','duplicate');
CREATE TYPE notify.channel        AS ENUM ('in_app','push','email');
```

### 3.1 Auth service

```sql
CREATE TABLE auth.players (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id      UUID NOT NULL DEFAULT gen_random_uuid(),   -- shareable, non-enumerable
  username       CITEXT NOT NULL,
  email          CITEXT,                                    -- nullable: OAuth/guest accounts
  email_verified BOOLEAN NOT NULL DEFAULT false,
  status         auth.account_status NOT NULL DEFAULT 'pending_verification',
  country_code   CHAR(2),
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  CONSTRAINT uq_players_public_id UNIQUE (public_id),
  CONSTRAINT uq_players_username  UNIQUE (username),
  CONSTRAINT ck_players_username  CHECK (char_length(username) BETWEEN 3 AND 20)
);
CREATE UNIQUE INDEX uq_players_email ON auth.players (email) WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_players_status ON auth.players (status);
CREATE TRIGGER trg_players_updated BEFORE UPDATE ON auth.players
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

CREATE TABLE auth.player_credentials (
  player_id      BIGINT PRIMARY KEY REFERENCES auth.players(id) ON DELETE CASCADE,
  password_hash  TEXT NOT NULL,               -- argon2id
  password_algo  TEXT NOT NULL DEFAULT 'argon2id',
  must_reset     BOOLEAN NOT NULL DEFAULT false,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth.player_oauth (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id    BIGINT NOT NULL REFERENCES auth.players(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,                  -- 'google','apple','game_center','facebook'
  provider_uid TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_oauth_provider_uid UNIQUE (provider, provider_uid)
);
CREATE INDEX ix_oauth_player ON auth.player_oauth (player_id);

-- Durable login/session AUDIT only. The live session lives in Redis.
CREATE TABLE auth.session_audit (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id    BIGINT NOT NULL REFERENCES auth.players(id) ON DELETE CASCADE,
  session_uid  UUID NOT NULL,
  platform     auth.platform_type NOT NULL,
  ip_addr      INET,
  device_id    TEXT,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX ix_session_audit_player ON auth.session_audit (player_id, issued_at DESC);
```

### 3.2 Bans & appeals (Auth-owned, consumed by Moderation)

```sql
CREATE TABLE auth.bans (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id    BIGINT NOT NULL REFERENCES auth.players(id) ON DELETE CASCADE,
  reason_code  TEXT NOT NULL,                  -- 'cheating','toxicity','fraud','tos'
  description  TEXT,
  is_permanent BOOLEAN NOT NULL DEFAULT false,
  starts_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,                    -- NULL when permanent
  issued_by    BIGINT,                         -- admin/staff id (logical FK to admin dir)
  revoked_at   TIMESTAMPTZ,
  revoked_by   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_ban_window CHECK (is_permanent OR expires_at IS NOT NULL)
);
-- At most one ACTIVE ban per player
CREATE UNIQUE INDEX uq_active_ban_per_player ON auth.bans (player_id)
  WHERE revoked_at IS NULL AND (is_permanent OR expires_at > now());
CREATE INDEX ix_bans_player ON auth.bans (player_id);

CREATE TABLE auth.ban_appeals (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ban_id       BIGINT NOT NULL REFERENCES auth.bans(id) ON DELETE CASCADE,
  player_id    BIGINT NOT NULL REFERENCES auth.players(id) ON DELETE CASCADE,
  message      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending/approved/rejected
  reviewed_by  BIGINT,
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_appeals_ban ON auth.ban_appeals (ban_id);
```

### 3.3 Profile service

```sql
CREATE TABLE profile.profiles (
  player_id       BIGINT PRIMARY KEY,          -- logical 1-1 FK -> auth.players(id)
  display_name    TEXT NOT NULL,
  avatar_item_id  BIGINT,                      -- logical FK -> inventory.skins
  banner_item_id  BIGINT,
  bio             TEXT,
  level           INT  NOT NULL DEFAULT 1,
  xp              BIGINT NOT NULL DEFAULT 0,
  title_id        BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_level_pos CHECK (level >= 1),
  CONSTRAINT ck_xp_pos    CHECK (xp >= 0)
);
CREATE INDEX ix_profiles_level ON profile.profiles (level DESC);
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON profile.profiles
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

CREATE TABLE profile.player_settings (
  player_id        BIGINT PRIMARY KEY,         -- logical FK -> auth.players
  language          CHAR(5) NOT NULL DEFAULT 'en-US',
  region            TEXT NOT NULL DEFAULT 'auto',
  push_enabled      BOOLEAN NOT NULL DEFAULT true,
  marketing_opt_in  BOOLEAN NOT NULL DEFAULT false,
  allow_friend_req  BOOLEAN NOT NULL DEFAULT true,
  privacy_stats     TEXT NOT NULL DEFAULT 'public', -- public/friends/private
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.4 Friends, requests, blocks

```sql
-- Symmetric friendship: store one canonical row with low_id < high_id.
CREATE TABLE profile.friends (
  low_id     BIGINT NOT NULL,
  high_id    BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (low_id, high_id),
  CONSTRAINT ck_friend_order CHECK (low_id < high_id)
);
CREATE INDEX ix_friends_high ON profile.friends (high_id);

CREATE TABLE profile.friend_requests (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requester_id BIGINT NOT NULL,               -- logical FK -> auth.players
  target_id    BIGINT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending/accepted/declined/cancelled
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  CONSTRAINT ck_no_self_req CHECK (requester_id <> target_id)
);
CREATE UNIQUE INDEX uq_pending_request ON profile.friend_requests (requester_id, target_id)
  WHERE status = 'pending';
CREATE INDEX ix_freq_target ON profile.friend_requests (target_id) WHERE status = 'pending';

CREATE TABLE profile.blocks (
  blocker_id BIGINT NOT NULL,
  blocked_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT ck_no_self_block CHECK (blocker_id <> blocked_id)
);
```

### 3.5 Guilds / Clans

```sql
CREATE TABLE profile.guilds (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         CITEXT NOT NULL,
  tag          CITEXT NOT NULL,               -- short [TAG]
  description  TEXT,
  emblem_id    INT,
  owner_id     BIGINT NOT NULL,               -- logical FK -> auth.players
  member_count INT NOT NULL DEFAULT 1,
  max_members  INT NOT NULL DEFAULT 50,
  level        INT NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  CONSTRAINT uq_guild_name UNIQUE (name),
  CONSTRAINT uq_guild_tag  UNIQUE (tag),
  CONSTRAINT ck_guild_tag  CHECK (char_length(tag) BETWEEN 2 AND 5)
);
CREATE TRIGGER trg_guilds_updated BEFORE UPDATE ON profile.guilds
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

CREATE TABLE profile.guild_members (
  guild_id   BIGINT NOT NULL REFERENCES profile.guilds(id) ON DELETE CASCADE,
  player_id  BIGINT NOT NULL,                 -- logical FK -> auth.players
  role       TEXT NOT NULL DEFAULT 'member',  -- owner/officer/member
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  contribution BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, player_id)
);
-- A player belongs to at most one guild.
CREATE UNIQUE INDEX uq_one_guild_per_player ON profile.guild_members (player_id);

CREATE TABLE profile.guild_invites (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id   BIGINT NOT NULL REFERENCES profile.guilds(id) ON DELETE CASCADE,
  inviter_id BIGINT NOT NULL,
  invitee_id BIGINT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_guild_invite UNIQUE (guild_id, invitee_id)
);
```

### 3.6 Inventory — catalog (class-table inheritance)

```sql
-- Abstract catalog root. Every ownable/definable game object is an item.
CREATE TABLE inventory.items (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL,                  -- stable content key e.g. 'wpn_ar_falcon'
  kind        inventory.item_kind NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  rarity      inventory.rarity NOT NULL DEFAULT 'common',
  is_tradable BOOLEAN NOT NULL DEFAULT false,
  max_stack   INT NOT NULL DEFAULT 1,
  released_at TIMESTAMPTZ,
  retired_at  TIMESTAMPTZ,                    -- vaulted content
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_item_code UNIQUE (code),
  CONSTRAINT ck_max_stack CHECK (max_stack >= 1)
);
CREATE INDEX ix_items_kind_rarity ON inventory.items (kind, rarity);
CREATE TRIGGER trg_items_updated BEFORE UPDATE ON inventory.items
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

CREATE TABLE inventory.weapons (
  item_id       BIGINT PRIMARY KEY REFERENCES inventory.items(id) ON DELETE CASCADE,
  weapon_class  TEXT NOT NULL,               -- ar/smg/sniper/shotgun/pistol/melee
  base_damage   NUMERIC(6,2) NOT NULL,
  fire_rate_rpm INT NOT NULL,
  magazine_size INT NOT NULL,
  reload_ms     INT NOT NULL,
  range_m       NUMERIC(6,2) NOT NULL,
  ammo_type     TEXT NOT NULL,
  CONSTRAINT ck_wpn_damage CHECK (base_damage > 0),
  CONSTRAINT ck_wpn_mag    CHECK (magazine_size > 0)
);

CREATE TABLE inventory.attachments (
  item_id      BIGINT PRIMARY KEY REFERENCES inventory.items(id) ON DELETE CASCADE,
  slot         TEXT NOT NULL,                 -- muzzle/optic/grip/mag/stock
  -- stat modifiers as additive/multiplicative deltas
  damage_mod   NUMERIC(5,2) NOT NULL DEFAULT 0,
  recoil_mod   NUMERIC(5,2) NOT NULL DEFAULT 0,
  range_mod    NUMERIC(5,2) NOT NULL DEFAULT 0,
  ads_speed_mod NUMERIC(5,2) NOT NULL DEFAULT 0
);
CREATE INDEX ix_attachments_slot ON inventory.attachments (slot);

CREATE TABLE inventory.skins (
  item_id     BIGINT PRIMARY KEY REFERENCES inventory.items(id) ON DELETE CASCADE,
  applies_to  TEXT NOT NULL,                  -- 'weapon:<code>' | 'character' | 'vehicle'
  target_item_id BIGINT REFERENCES inventory.items(id), -- weapon skinned, if any
  texture_ref TEXT NOT NULL,                  -- CDN/content path
  is_animated BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX ix_skins_target ON inventory.skins (target_item_id);

-- M:N weapon <-> compatible attachment
CREATE TABLE inventory.weapon_attachment_compat (
  weapon_item_id     BIGINT NOT NULL REFERENCES inventory.weapons(item_id) ON DELETE CASCADE,
  attachment_item_id BIGINT NOT NULL REFERENCES inventory.attachments(item_id) ON DELETE CASCADE,
  PRIMARY KEY (weapon_item_id, attachment_item_id)
);
CREATE INDEX ix_compat_attachment ON inventory.weapon_attachment_compat (attachment_item_id);
```

### 3.7 Inventory — player ownership & loadouts

```sql
CREATE TABLE inventory.player_inventory (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id    BIGINT NOT NULL,               -- logical FK -> auth.players
  item_id      BIGINT NOT NULL REFERENCES inventory.items(id),
  quantity     INT NOT NULL DEFAULT 1,
  acquired_via inventory.acquire_src NOT NULL,
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,                   -- rentals / timed grants
  is_equipped  BOOLEAN NOT NULL DEFAULT false,
  is_favorite  BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT ck_inv_qty CHECK (quantity >= 0)
);
-- One row per (player,item) for non-stacking uniques.
CREATE UNIQUE INDEX uq_player_unique_item ON inventory.player_inventory (player_id, item_id)
  WHERE expires_at IS NULL;
CREATE INDEX ix_inv_player ON inventory.player_inventory (player_id);
CREATE INDEX ix_inv_item   ON inventory.player_inventory (item_id);

CREATE TABLE inventory.loadouts (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id  BIGINT NOT NULL,                 -- logical FK -> auth.players
  name       TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_active_loadout ON inventory.loadouts (player_id) WHERE is_active;
CREATE INDEX ix_loadouts_player ON inventory.loadouts (player_id);

CREATE TABLE inventory.loadout_slots (
  loadout_id        BIGINT NOT NULL REFERENCES inventory.loadouts(id) ON DELETE CASCADE,
  slot              TEXT NOT NULL,            -- primary/secondary/skin/emote1...
  inventory_id      BIGINT NOT NULL REFERENCES inventory.player_inventory(id) ON DELETE CASCADE,
  PRIMARY KEY (loadout_id, slot)
);
```

### 3.8 Match service

```sql
CREATE TABLE match.maps (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       TEXT NOT NULL,                   -- from Map Editor export
  name       TEXT NOT NULL,
  max_players INT NOT NULL DEFAULT 100,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_map_code UNIQUE (code)
);

CREATE TABLE match.game_modes (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       TEXT NOT NULL,                   -- 'solo','duo','squad','ranked_squad'
  name       TEXT NOT NULL,
  team_size  INT NOT NULL DEFAULT 1,
  is_ranked  BOOLEAN NOT NULL DEFAULT false,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT uq_mode_code UNIQUE (code)
);

CREATE TABLE match.matches (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id     UUID NOT NULL DEFAULT gen_random_uuid(),
  map_id        BIGINT NOT NULL REFERENCES match.maps(id),
  game_mode_id  BIGINT NOT NULL REFERENCES match.game_modes(id),
  season_id     BIGINT,                       -- logical FK -> ranking.seasons
  region        TEXT NOT NULL,
  state         match.match_state NOT NULL DEFAULT 'created',
  server_id     TEXT,                         -- dedicated server instance
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  player_count  INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_match_public UNIQUE (public_id)
);
CREATE INDEX ix_matches_mode_time ON match.matches (game_mode_id, started_at DESC);
CREATE INDEX ix_matches_season    ON match.matches (season_id);
CREATE INDEX ix_matches_state     ON match.matches (state) WHERE state = 'in_progress';

CREATE TABLE match.match_participants (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  match_id       BIGINT NOT NULL REFERENCES match.matches(id) ON DELETE CASCADE,
  player_id      BIGINT NOT NULL,             -- logical FK -> auth.players
  team_no        INT,
  placement      INT,                         -- 1 = winner
  result         match.participant_result,
  kills          INT NOT NULL DEFAULT 0,
  assists        INT NOT NULL DEFAULT 0,
  deaths         INT NOT NULL DEFAULT 0,
  damage_dealt   INT NOT NULL DEFAULT 0,
  damage_taken   INT NOT NULL DEFAULT 0,
  revives        INT NOT NULL DEFAULT 0,
  survival_ms    INT NOT NULL DEFAULT 0,
  distance_m     INT NOT NULL DEFAULT 0,
  mmr_before     INT,
  mmr_after      INT,
  xp_earned      INT NOT NULL DEFAULT 0,
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_match_player UNIQUE (match_id, player_id)
);
CREATE INDEX ix_participants_player ON match.match_participants (player_id, joined_at DESC);
CREATE INDEX ix_participants_match  ON match.match_participants (match_id);

-- High-volume event log; partition by month in production.
CREATE TABLE match.match_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY,
  match_id    BIGINT NOT NULL,
  event_type  TEXT NOT NULL,                  -- kill/knock/revive/loot/ring
  actor_id    BIGINT,
  target_id   BIGINT,
  weapon_item_id BIGINT,
  payload     JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX ix_match_events_match ON match.match_events (match_id, occurred_at);
```

### 3.9 Statistics

```sql
-- Lifetime aggregate, one row per player (maintained by Match svc consumers).
CREATE TABLE match.player_statistics (
  player_id      BIGINT PRIMARY KEY,          -- logical FK -> auth.players
  matches_played INT NOT NULL DEFAULT 0,
  wins           INT NOT NULL DEFAULT 0,
  top10          INT NOT NULL DEFAULT 0,
  kills          BIGINT NOT NULL DEFAULT 0,
  deaths         BIGINT NOT NULL DEFAULT 0,
  assists        BIGINT NOT NULL DEFAULT 0,
  damage_dealt   BIGINT NOT NULL DEFAULT 0,
  headshots      BIGINT NOT NULL DEFAULT 0,
  total_survival_ms BIGINT NOT NULL DEFAULT 0,
  longest_kill_m INT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_stats_nonneg CHECK (matches_played >= 0 AND wins >= 0)
);

-- Per mode + season breakdown.
CREATE TABLE match.player_mode_statistics (
  player_id      BIGINT NOT NULL,
  game_mode_id   BIGINT NOT NULL REFERENCES match.game_modes(id),
  season_id      BIGINT NOT NULL,             -- logical FK -> ranking.seasons
  matches_played INT NOT NULL DEFAULT 0,
  wins           INT NOT NULL DEFAULT 0,
  kills          BIGINT NOT NULL DEFAULT 0,
  deaths         BIGINT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, game_mode_id, season_id)
);
CREATE INDEX ix_mode_stats_season ON match.player_mode_statistics (season_id, game_mode_id);
```

### 3.10 Ranking / Seasons

```sql
CREATE TABLE ranking.seasons (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       TEXT NOT NULL,                   -- 'S1','S2'
  name       TEXT NOT NULL,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_season_code UNIQUE (code),
  CONSTRAINT ck_season_window CHECK (ends_at > starts_at)
);
-- Only one active season at a time.
CREATE UNIQUE INDEX uq_one_active_season ON ranking.seasons ((is_active)) WHERE is_active;

CREATE TABLE ranking.ranks (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL,                  -- 'bronze','gold','diamond','conqueror'
  name        TEXT NOT NULL,
  tier_order  INT NOT NULL,                   -- ascending ordering
  min_points  INT NOT NULL,
  max_points  INT,
  CONSTRAINT uq_rank_code UNIQUE (code),
  CONSTRAINT uq_rank_order UNIQUE (tier_order)
);

CREATE TABLE ranking.player_rank_progress (
  player_id    BIGINT NOT NULL,               -- logical FK -> auth.players
  season_id    BIGINT NOT NULL REFERENCES ranking.seasons(id) ON DELETE CASCADE,
  rank_id      BIGINT NOT NULL REFERENCES ranking.ranks(id),
  rank_points  INT NOT NULL DEFAULT 0,
  mmr          INT NOT NULL DEFAULT 1000,
  peak_points  INT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, season_id)
);
CREATE INDEX ix_rank_progress_season ON ranking.player_rank_progress (season_id, rank_points DESC);

-- Periodic materialization of the Redis leaderboard for durability/history.
CREATE TABLE ranking.leaderboard_snapshots (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  season_id    BIGINT NOT NULL REFERENCES ranking.seasons(id) ON DELETE CASCADE,
  game_mode_id BIGINT NOT NULL,
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  rows         JSONB NOT NULL                 -- [{player_id,rank,points}]
);
CREATE INDEX ix_lb_snap ON ranking.leaderboard_snapshots (season_id, game_mode_id, captured_at DESC);
```

### 3.11 Store

```sql
CREATE TABLE store.store_categories (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  CONSTRAINT uq_store_cat UNIQUE (code)
);

CREATE TABLE store.store_items (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id   BIGINT NOT NULL REFERENCES store.store_categories(id),
  item_id       BIGINT NOT NULL,             -- logical FK -> inventory.items
  name          TEXT NOT NULL,
  is_featured   BOOLEAN NOT NULL DEFAULT false,
  available_from TIMESTAMPTZ,
  available_to   TIMESTAMPTZ,
  purchase_limit INT,                         -- per-player cap; NULL = unlimited
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_store_items_cat ON store.store_items (category_id) WHERE is_active;
CREATE INDEX ix_store_items_item ON store.store_items (item_id);
CREATE TRIGGER trg_store_items_updated BEFORE UPDATE ON store.store_items
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- Price per currency (real/soft/hard) and optional region.
CREATE TABLE store.store_item_prices (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_item_id  BIGINT NOT NULL REFERENCES store.store_items(id) ON DELETE CASCADE,
  currency_kind  store.currency_kind NOT NULL,
  currency_code  TEXT NOT NULL,               -- 'USD' | 'PHX_COIN' | 'PHX_GEM'
  amount_minor   BIGINT NOT NULL,             -- minor units / integer game currency
  region         TEXT,                        -- NULL = default/global
  CONSTRAINT ck_price_pos CHECK (amount_minor >= 0),
  CONSTRAINT uq_price_scope UNIQUE (store_item_id, currency_code, region)
);

CREATE TABLE store.bundles (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  discount_bps INT NOT NULL DEFAULT 0,        -- basis points off sum of parts
  is_active   BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT uq_bundle_code UNIQUE (code)
);

CREATE TABLE store.bundle_items (
  bundle_id     BIGINT NOT NULL REFERENCES store.bundles(id) ON DELETE CASCADE,
  store_item_id BIGINT NOT NULL REFERENCES store.store_items(id) ON DELETE CASCADE,
  quantity      INT NOT NULL DEFAULT 1,
  PRIMARY KEY (bundle_id, store_item_id)
);
```

### 3.12 Payments & Wallet

```sql
CREATE TABLE payments.payment_methods (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id    BIGINT NOT NULL,              -- logical FK -> auth.players
  provider     TEXT NOT NULL,               -- 'apple_iap','google_play','stripe'
  provider_ref TEXT NOT NULL,               -- tokenized; NEVER raw PAN
  brand        TEXT,
  last4        CHAR(4),
  is_default   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pm_provider_ref UNIQUE (provider, provider_ref)
);
CREATE INDEX ix_pm_player ON payments.payment_methods (player_id);

CREATE TABLE payments.payments (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id      UUID NOT NULL DEFAULT gen_random_uuid(),
  player_id      BIGINT NOT NULL,            -- logical FK -> auth.players
  provider       TEXT NOT NULL,
  provider_txn_id TEXT,                      -- receipt / charge id
  status         payments.txn_status NOT NULL DEFAULT 'pending',
  amount_minor   BIGINT NOT NULL,
  currency_code  CHAR(3) NOT NULL,
  idempotency_key UUID NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_idem UNIQUE (idempotency_key),
  CONSTRAINT uq_payment_provider_txn UNIQUE (provider, provider_txn_id),
  CONSTRAINT ck_payment_amount CHECK (amount_minor > 0)
);
CREATE INDEX ix_payments_player ON payments.payments (player_id, created_at DESC);
CREATE INDEX ix_payments_status ON payments.payments (status);
CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON payments.payments
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- A purchase = fulfillment record tied to a payment (real money) OR a wallet spend (game currency).
CREATE TABLE payments.purchases (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id     BIGINT NOT NULL,             -- logical FK -> auth.players
  payment_id    BIGINT REFERENCES payments.payments(id),  -- NULL for pure game-currency spend
  currency_code TEXT NOT NULL,
  total_minor   BIGINT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'completed', -- completed/pending/failed/refunded
  fulfilled_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_purchase_total CHECK (total_minor >= 0)
);
CREATE INDEX ix_purchases_player ON payments.purchases (player_id, created_at DESC);

CREATE TABLE payments.purchase_lines (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_id   BIGINT NOT NULL REFERENCES payments.purchases(id) ON DELETE CASCADE,
  store_item_id BIGINT NOT NULL,             -- logical FK -> store.store_items
  item_id       BIGINT NOT NULL,             -- logical FK -> inventory.items (granted)
  quantity      INT NOT NULL DEFAULT 1,
  unit_minor    BIGINT NOT NULL,
  CONSTRAINT ck_line_qty CHECK (quantity > 0)
);
CREATE INDEX ix_purchase_lines_purchase ON payments.purchase_lines (purchase_id);

-- Player wallet, one account per (player,currency). Balance is derived but cached here.
CREATE TABLE payments.wallet_accounts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id     BIGINT NOT NULL,             -- logical FK -> auth.players
  currency_code TEXT NOT NULL,               -- 'PHX_COIN','PHX_GEM'
  balance       BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_wallet UNIQUE (player_id, currency_code),
  CONSTRAINT ck_wallet_balance CHECK (balance >= 0)
);

-- Immutable, append-only double-entry ledger. balance = sum(delta).
CREATE TABLE payments.wallet_ledger (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES payments.wallet_accounts(id),
  delta        BIGINT NOT NULL,              -- + credit / - debit
  balance_after BIGINT NOT NULL,
  reason       TEXT NOT NULL,                -- 'purchase','refund','reward','admin_grant'
  ref_type     TEXT,                         -- 'purchase' | 'reward_grant' | ...
  ref_id       BIGINT,
  idempotency_key UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_ledger_idem UNIQUE (idempotency_key)
);
CREATE INDEX ix_ledger_account ON payments.wallet_ledger (account_id, created_at DESC);

CREATE TABLE payments.refunds (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id   BIGINT NOT NULL REFERENCES payments.payments(id),
  amount_minor BIGINT NOT NULL,
  reason       TEXT,
  provider_ref TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_refund_amount CHECK (amount_minor > 0)
);
CREATE INDEX ix_refunds_payment ON payments.refunds (payment_id);
```

### 3.13 Battle Pass

```sql
CREATE TABLE battlepass.battle_passes (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  season_id  BIGINT NOT NULL,               -- logical FK -> ranking.seasons (1-1)
  name       TEXT NOT NULL,
  max_tier   INT NOT NULL DEFAULT 100,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  price_gem  BIGINT,                         -- premium unlock cost (hard currency)
  is_active  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_bp_season UNIQUE (season_id),
  CONSTRAINT ck_bp_window CHECK (ends_at > starts_at)
);

CREATE TABLE battlepass.battle_pass_tiers (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  battle_pass_id BIGINT NOT NULL REFERENCES battlepass.battle_passes(id) ON DELETE CASCADE,
  tier_no        INT NOT NULL,
  xp_required    INT NOT NULL,               -- cumulative XP to reach this tier
  CONSTRAINT uq_bp_tier UNIQUE (battle_pass_id, tier_no),
  CONSTRAINT ck_tier_no CHECK (tier_no >= 1)
);

CREATE TABLE battlepass.battle_pass_rewards (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tier_id    BIGINT NOT NULL REFERENCES battlepass.battle_pass_tiers(id) ON DELETE CASCADE,
  track      battlepass.track_type NOT NULL, -- free vs premium track
  reward_id  BIGINT NOT NULL,               -- logical FK -> rewards.rewards
  CONSTRAINT uq_bp_reward UNIQUE (tier_id, track)
);

CREATE TABLE battlepass.player_battle_pass (
  player_id      BIGINT NOT NULL,            -- logical FK -> auth.players
  battle_pass_id BIGINT NOT NULL REFERENCES battlepass.battle_passes(id) ON DELETE CASCADE,
  has_premium    BOOLEAN NOT NULL DEFAULT false,
  purchased_at   TIMESTAMPTZ,
  PRIMARY KEY (player_id, battle_pass_id)
);

CREATE TABLE battlepass.battle_pass_progress (
  player_id       BIGINT NOT NULL,
  battle_pass_id  BIGINT NOT NULL REFERENCES battlepass.battle_passes(id) ON DELETE CASCADE,
  current_tier    INT NOT NULL DEFAULT 0,
  current_xp      INT NOT NULL DEFAULT 0,
  claimed_tiers   INT[] NOT NULL DEFAULT '{}', -- tiers whose reward was claimed
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, battle_pass_id),
  CONSTRAINT ck_bp_progress CHECK (current_tier >= 0 AND current_xp >= 0)
);
CREATE INDEX ix_bp_progress_bp ON battlepass.battle_pass_progress (battle_pass_id, current_tier DESC);
```

### 3.14 Missions

```sql
CREATE TABLE battlepass.missions (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  battle_pass_id BIGINT REFERENCES battlepass.battle_passes(id) ON DELETE CASCADE, -- NULL = evergreen
  code           TEXT NOT NULL,
  name           TEXT NOT NULL,
  mission_type   TEXT NOT NULL,             -- 'daily','weekly','seasonal'
  xp_reward      INT NOT NULL DEFAULT 0,
  reward_id      BIGINT,                    -- optional item reward, logical FK -> rewards.rewards
  starts_at      TIMESTAMPTZ,
  ends_at        TIMESTAMPTZ,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT uq_mission_code UNIQUE (code)
);
CREATE INDEX ix_missions_bp ON battlepass.missions (battle_pass_id);

CREATE TABLE battlepass.mission_objectives (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mission_id   BIGINT NOT NULL REFERENCES battlepass.missions(id) ON DELETE CASCADE,
  metric       TEXT NOT NULL,              -- 'kills','wins','damage','matches','revives'
  target_value INT NOT NULL,
  CONSTRAINT ck_obj_target CHECK (target_value > 0)
);

CREATE TABLE battlepass.player_missions (
  player_id    BIGINT NOT NULL,            -- logical FK -> auth.players
  mission_id   BIGINT NOT NULL REFERENCES battlepass.missions(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'in_progress', -- in_progress/completed/claimed/expired
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  claimed_at   TIMESTAMPTZ,
  PRIMARY KEY (player_id, mission_id)
);
CREATE INDEX ix_player_missions_status ON battlepass.player_missions (player_id, status);

CREATE TABLE battlepass.player_mission_progress (
  player_id    BIGINT NOT NULL,
  objective_id BIGINT NOT NULL REFERENCES battlepass.mission_objectives(id) ON DELETE CASCADE,
  progress     INT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, objective_id),
  CONSTRAINT ck_progress_nonneg CHECK (progress >= 0)
);
```

### 3.15 Rewards & Loot

```sql
-- Reward = a definition of "what you get" (bundle of currency/items).
CREATE TABLE rewards.rewards (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  reward_type  TEXT NOT NULL,              -- 'item','currency','xp','crate','mixed'
  item_id      BIGINT,                     -- logical FK -> inventory.items
  currency_code TEXT,                      -- for currency rewards
  amount       BIGINT NOT NULL DEFAULT 0,  -- currency/xp amount or item qty
  CONSTRAINT uq_reward_code UNIQUE (code)
);

-- Ledger of granted rewards (idempotent, auditable).
CREATE TABLE rewards.reward_grants (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id    BIGINT NOT NULL,            -- logical FK -> auth.players
  reward_id    BIGINT NOT NULL REFERENCES rewards.rewards(id),
  source_type  TEXT NOT NULL,             -- 'battlepass','mission','loot','store','admin'
  source_id    BIGINT,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key UUID NOT NULL,
  CONSTRAINT uq_grant_idem UNIQUE (idempotency_key)
);
CREATE INDEX ix_grants_player ON rewards.reward_grants (player_id, granted_at DESC);

CREATE TABLE rewards.loot_tables (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL,               -- 'crate_common','event_summer'
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_loot_table_code UNIQUE (code)
);

-- Weighted entries. drop probability = weight / SUM(weight) within table.
CREATE TABLE rewards.loot_table_entries (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  loot_table_id BIGINT NOT NULL REFERENCES rewards.loot_tables(id) ON DELETE CASCADE,
  reward_id     BIGINT NOT NULL REFERENCES rewards.rewards(id),
  weight        INT NOT NULL,               -- relative weight
  rarity        inventory.rarity NOT NULL DEFAULT 'common',
  drop_rate_bps INT,                        -- published rate (basis points) for transparency/legal
  max_per_roll  INT NOT NULL DEFAULT 1,
  CONSTRAINT ck_loot_weight CHECK (weight > 0)
);
CREATE INDEX ix_loot_entries_table ON rewards.loot_table_entries (loot_table_id);

-- Audit log of every roll (regulatory drop-rate proof + fraud detection).
CREATE TABLE rewards.loot_drops (
  id            BIGINT GENERATED ALWAYS AS IDENTITY,
  player_id     BIGINT NOT NULL,
  loot_table_id BIGINT NOT NULL,
  entry_id      BIGINT NOT NULL,
  reward_id     BIGINT NOT NULL,
  rolled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  seed          BIGINT,
  PRIMARY KEY (id, rolled_at)
) PARTITION BY RANGE (rolled_at);
CREATE INDEX ix_loot_drops_player ON rewards.loot_drops (player_id, rolled_at DESC);
```

### 3.16 Notifications

```sql
CREATE TABLE notify.notification_templates (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       TEXT NOT NULL,
  channel    notify.channel NOT NULL,
  title_tpl  TEXT NOT NULL,
  body_tpl   TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT uq_notif_tpl UNIQUE (code, channel)
);

CREATE TABLE notify.notifications (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id   BIGINT NOT NULL,             -- logical FK -> auth.players
  template_id BIGINT REFERENCES notify.notification_templates(id),
  channel     notify.channel NOT NULL DEFAULT 'in_app',
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  data        JSONB,                       -- deep-link payload
  is_read     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ
);
CREATE INDEX ix_notif_player_unread ON notify.notifications (player_id, created_at DESC)
  WHERE is_read = false;

CREATE TABLE notify.device_tokens (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id  BIGINT NOT NULL,              -- logical FK -> auth.players
  platform   auth.platform_type NOT NULL,
  token      TEXT NOT NULL,               -- FCM/APNs token
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_device_token UNIQUE (token)
);
CREATE INDEX ix_device_tokens_player ON notify.device_tokens (player_id) WHERE is_active;
```

### 3.17 Moderation — Reports & actions

```sql
CREATE TABLE moderation.reports (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reporter_id   BIGINT NOT NULL,           -- logical FK -> auth.players
  reported_id   BIGINT NOT NULL,           -- logical FK -> auth.players
  match_id      BIGINT,                    -- logical FK -> match.matches (context)
  category      TEXT NOT NULL,             -- 'cheating','toxic_chat','teaming','name'
  description   TEXT,
  status        moderation.report_status NOT NULL DEFAULT 'open',
  handled_by    BIGINT,
  handled_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_no_self_report CHECK (reporter_id <> reported_id)
);
CREATE INDEX ix_reports_reported ON moderation.reports (reported_id, created_at DESC);
CREATE INDEX ix_reports_status   ON moderation.reports (status) WHERE status IN ('open','triaging');
-- One open report per (reporter,reported,match) to curb spam.
CREATE UNIQUE INDEX uq_report_dedup ON moderation.reports (reporter_id, reported_id, COALESCE(match_id,0))
  WHERE status = 'open';

CREATE TABLE moderation.report_evidence (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_id  BIGINT NOT NULL REFERENCES moderation.reports(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL,            -- 'replay','screenshot','chat_log'
  ref        TEXT NOT NULL,               -- CDN/object-store key
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE moderation.moderation_actions (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_id   BIGINT REFERENCES moderation.reports(id) ON DELETE SET NULL,
  target_id   BIGINT NOT NULL,            -- logical FK -> auth.players
  action_type TEXT NOT NULL,             -- 'warn','mute','ban','stat_reset','no_action'
  ban_id      BIGINT,                    -- logical FK -> auth.bans, if a ban resulted
  notes       TEXT,
  acted_by    BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_modactions_target ON moderation.moderation_actions (target_id, created_at DESC);
```

### 3.18 Platform — Logs, audit, idempotency, outbox

```sql
-- Admin/staff action audit (dashboard, LiveOps). Append-only, monthly partitions.
CREATE TABLE platform.audit_logs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY,
  actor_id    BIGINT,                      -- staff/admin id
  actor_type  TEXT NOT NULL DEFAULT 'staff',
  action      TEXT NOT NULL,              -- 'ban.create','store.item.update'
  entity_type TEXT,
  entity_id   TEXT,
  before      JSONB,
  after       JSONB,
  ip_addr     INET,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX ix_audit_entity ON platform.audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX ix_audit_actor  ON platform.audit_logs (actor_id, occurred_at DESC);

-- Generic application/analytics event log (also mirrored to Kafka). Monthly partitions.
CREATE TABLE platform.event_logs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY,
  event_name  TEXT NOT NULL,
  player_id   BIGINT,
  service     TEXT NOT NULL,
  payload     JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX ix_event_logs_name ON platform.event_logs (event_name, occurred_at DESC);
CREATE INDEX ix_event_logs_player ON platform.event_logs (player_id, occurred_at DESC);

-- Durable idempotency store (long window; Redis holds the short window).
CREATE TABLE platform.idempotency_keys (
  key         UUID PRIMARY KEY,
  scope       TEXT NOT NULL,             -- 'payment','reward_grant','purchase'
  request_hash TEXT NOT NULL,
  response    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX ix_idem_expiry ON platform.idempotency_keys (expires_at);

-- Transactional outbox: each service writes events here in the same tx as its data,
-- a relay publishes to Kafka. Guarantees exactly-once-ish cross-service consistency.
CREATE TABLE platform.outbox (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate    TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_outbox_unpublished ON platform.outbox (created_at) WHERE published_at IS NULL;
```

### 3.19 Example partition bootstrap (for the partitioned tables)

```sql
-- Create the current + next month partitions (automate via pg_partman in prod).
CREATE TABLE match.match_events_2026_07 PARTITION OF match.match_events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE rewards.loot_drops_2026_07 PARTITION OF rewards.loot_drops
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE platform.audit_logs_2026_07 PARTITION OF platform.audit_logs
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE platform.event_logs_2026_07 PARTITION OF platform.event_logs
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
```

---

## 4. Cross-service FK policy (summary)

Because each microservice owns its schema and (in production) may run on a **separate physical database**, the following relationships are **logical foreign keys** — validated in application code and kept consistent via the `platform.outbox` → Kafka event stream, not by database `REFERENCES`:

- Any `player_id` outside `auth` (Profile, Inventory, Match, Payments, BattlePass, Rewards, Notify, Moderation).
- `store_items.item_id` / `purchase_lines.item_id` → `inventory.items`.
- `matches.season_id`, `battle_passes.season_id`, `player_mode_statistics.season_id` → `ranking.seasons`.
- `battle_pass_rewards.reward_id`, `missions.reward_id` → `rewards.rewards`.
- `moderation.moderation_actions.ban_id` → `auth.bans`.

FKs shown with real `REFERENCES` clauses above are **intra-schema** and therefore safe as hard constraints. If Phoenix is deployed as a single shared Postgres cluster in early stages, the logical FKs can be promoted to real ones without schema changes (they already carry the correct types and columns).

## 5. Data lifecycle notes

- **GDPR erasure:** `auth.players.deleted_at` triggers a fan-out erasure job; PII in `profiles`, `payment_methods`, and `session_audit` is anonymized while immutable financial ledgers (`payments`, `wallet_ledger`) are retained per financial-records law with the player pseudonymized.
- **Retention:** partitioned log tables (`match_events`, `loot_drops`, `event_logs`, `audit_logs`) are dropped by partition on a rolling window (e.g. 90 days hot, then cold storage).
- **Hot vs cold:** live match state and matchmaking never touch Postgres; only committed results do. Leaderboards are Redis-authoritative with periodic `leaderboard_snapshots` for history.
