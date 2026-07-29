# 09 — Live-Ops & Economy Design

**Project Phoenix** — AAA Mobile Battle Royale Platform
**Owner:** Lead Live-Ops / Economy Designer
**Status:** Design spec (buildable) · **Doc version:** 1.0 · **Last updated:** 2026-07-29

> Scope: This document specifies the seasonal cadence, Battle Pass, store & monetization,
> progression, matchmaking-adjacent economy inputs, reward/drop systems, the data-driven
> Live-Ops event framework, and the KPIs & ethical guardrails that govern all of the above.
> It is written to be implemented directly by the Economy, Backend, and Client teams.
> Phoenix is an original title. Nothing here copies another game's assets, names, or content.

---

## 0. System Map & Ownership

```
                         ┌───────────────────────────────────────┐
                         │            Admin Dashboard             │
                         │  (config authoring, scheduling, A/B)   │
                         └───────────────┬───────────────────────┘
                                         │ publishes signed config bundles
                                         ▼
   ┌──────────────┐   ┌──────────────┐   ┌───────────────┐   ┌──────────────┐
   │ Season Svc   │   │ BattlePass   │   │  Store Svc     │   │  Events Svc  │
   │ (rank reset, │   │ Svc (tiers,  │   │ (catalog,      │   │ (calendar,   │
   │  rewards)    │   │  XP, claims) │   │  offers, IAP)  │   │  schedules)  │
   └──────┬───────┘   └──────┬───────┘   └───────┬────────┘   └──────┬───────┘
          │                  │                   │                   │
          └───────────┬──────┴─────────┬─────────┴─────────┬─────────┘
                      ▼                 ▼                   ▼
             ┌────────────────┐  ┌──────────────┐   ┌────────────────┐
             │  Wallet Svc    │  │ Inventory Svc│   │ Payment Svc    │
             │ (currencies)   │  │ (items/dupes)│   │ (IAP receipts, │
             └────────┬───────┘  └──────┬───────┘   │  idempotency)  │
                      │                 │           └────────┬───────┘
                      └────────┬────────┴────────────────────┘
                               ▼
                    ┌──────────────────────┐
                    │  Ledger (append-only)│  ← single source of economic truth
                    └──────────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  Analytics / Data Lake│  → KPIs, A/B, fraud, LTV models
                    └──────────────────────┘
```

**Design principle:** All economy state changes are **server-authoritative** and flow through an
**append-only Ledger**. The client never grants currency, XP, or items. The client only *requests*;
the server *decides, writes, and confirms*. Every grant is traceable to a `source_event`.

| Service | Owns | Team |
|---|---|---|
| Season Service | Season lifecycle, rank tiers, reset, seasonal rewards | Live-Ops BE |
| BattlePass Service | Pass definitions, tier math, XP crediting, claims | Economy BE |
| Store Service | Catalog, pricing, offers, coupons, subscriptions | Monetization BE |
| Payment Service | IAP receipt validation, idempotency, refunds/chargebacks | Payments BE |
| Wallet Service | Currency balances (soft/premium/bound) | Economy BE |
| Inventory Service | Item ownership, duplicates, cosmetic equip state | Economy BE |
| Events Service | Live-Ops calendar, event configs, feature flags | Live-Ops BE |
| Ledger | Immutable audit of every economic transaction | Platform BE |

---

## 1. Season System

### 1.1 Cadence

| Parameter | Value | Rationale |
|---|---|---|
| Season length | **9 weeks (63 days)** | Long enough to complete a full Battle Pass at ~35–45 min/day; short enough to keep novelty. |
| Mid-season refresh | **Week 5** | New event, mid-pass reward drop, map rotation to counter the mid-season dip. |
| Off-season gap | **0 days (rolling)** | Season N+1 starts at the instant Season N ends; a 48h "grace claim" window keeps unclaimed rewards claimable. |
| Themed identity | 1 per season | Each season ships a narrative theme, cosmetic line, map skin, and event arc. |

A season is a **config object**, not code. Shipping a season = publishing a new `SeasonConfig` bundle.

```jsonc
// SeasonConfig (authored in Admin Dashboard, versioned, signed)
{
  "season_id": "S14",
  "display_name": "Ashfall",
  "starts_at": "2026-08-05T17:00:00Z",
  "ends_at":   "2026-10-07T17:00:00Z",
  "grace_claim_until": "2026-10-09T17:00:00Z",
  "battle_pass_id": "bp_s14",
  "rank_reset": { "policy": "soft", "soft_drop_tiers": 6 },
  "map_rotation": ["dune_expanse", "cinder_bay"],
  "seasonal_reward_track_id": "rank_rewards_s14",
  "theme_asset_bundle": "cdn://themes/s14_ashfall_v3"
}
```

### 1.2 Ranked ladder & reset

Two parallel progressions exist and must not be confused:

- **Rank (skill):** competitive tier from ranked matches. Resets each season.
- **Battle Pass level (engagement):** time/effort spent. Resets each season, unrelated to skill.

**Rank tiers** (each tier except the apex has 3 divisions):

| Tier | Divisions | MMR band (approx) |
|---|---|---|
| Ember | III–I | 0–999 |
| Bronze | III–I | 1000–1499 |
| Silver | III–I | 1500–1999 |
| Gold | III–I | 2000–2499 |
| Platinum | III–I | 2500–2999 |
| Diamond | III–I | 3000–3599 |
| Ascendant | III–I | 3600–4199 |
| Phoenix (apex) | — (leaderboard) | 4200+ |

**Reset policy — "soft reset" (recommended):** at season rollover a player's *displayed rank* drops
by `soft_drop_tiers` divisions, but hidden MMR is retained at ~80% (`new_mmr = 0.8 * old_mmr + 0.2 * mmr_floor`).
This gives players the satisfying climb again without throwing them into lobbies far below their skill
(which would harm the experience of newer players via smurf-like stomping).

### 1.3 Seasonal (rank) rewards

Rank rewards are the **prestige** layer — you cannot buy them, only earn them. This protects the
integrity of monetization (paying players still visibly earn skill rewards separately).

| Peak tier reached | Reward |
|---|---|
| Bronze | Seasonal banner (Bronze) |
| Silver | Banner + 50 soft currency |
| Gold | Animated banner + weapon charm |
| Platinum | Ranked weapon skin (tier-locked) |
| Diamond | Skin + loading-screen card |
| Ascendant | Full weapon set + emote |
| Phoenix | Exclusive character skin + evolving badge (kill count tracked) + top-500 leaderboard title |

### 1.4 How seasons drive engagement

- **Reset-and-climb loop:** clears the ladder so everyone has a fresh goal on day 1.
- **FOMO done ethically:** seasonal cosmetics are time-limited to create urgency, but we **never** re-sell
  the exact same item later relabeled (see §10 ethics). Old passes may vault and return in a clearly labeled
  "Vault" at a later date so lapsed players aren't permanently punished.
- **Narrative arc:** weekly story beats + the Week 5 refresh give two engagement peaks per season.
- **Catch-up mechanics:** BP XP "rested bonus" and weekly missions let returning players close the gap,
  reducing churn from "I'm too far behind."

---

## 2. Battle Pass

### 2.1 Structure

| Property | Value |
|---|---|
| Tiers per pass | **100** |
| Tracks | **Free** and **Premium** (+ optional **Premium+** bundle that grants +25 instant tiers) |
| XP per tier | Ramped: `xp(tier) = 1000 + 100 * floor(tier / 10)` (soft ramp, caps at 1900) |
| Full completion target | ~48 hrs of play or ~40 min/day over the season |
| Post-100 (overflow) | Each additional 1900 XP grants **10 premium currency** (soft prestige, uncapped) |
| Premium price | 950 premium currency (≈ US$9.99 pack) |
| Premium+ price | 2800 premium currency (≈ US$24.99), includes 25 tiers |

### 2.2 Track comparison

| Tier band | Free track | Premium track |
|---|---|---|
| Every tier | — | Cosmetic drip (sprays, charms, XP boosts) |
| Every 5 tiers | Soft currency / consumables | Premium currency chunk (net ~1300 over the pass, so an engaged buyer roughly earns back the next pass) |
| Milestone (10/25/50/75) | 1 emote, 1 banner | Themed weapon skins |
| Tier 1 | Instant character variant | Instant "reactive" weapon skin |
| Tier 100 | Legacy badge | **Mythic evolving skin** (levels up with post-100 XP) |

> **Earn-back design:** premium track returns ~1300 premium currency across 100 tiers. This is deliberate:
> completionists can self-fund the next pass, which is a pro-consumer retention loop, not a loss. It is
> funded by the long tail of buyers who don't finish.

### 2.3 XP sources

| Source | XP | Cap |
|---|---|---|
| Match completion | 200 base + 15/placement-rank + 50/kill | — |
| First win of the day | 500 | 1/day |
| Daily mission | 1500 each | 3/day |
| Weekly mission | 5000 each | 7/week |
| Seasonal mission (long-tail) | 10000 each | ~15/season |
| Friend-squad bonus | +10% match XP | while grouped |
| Rested bonus | +50% match XP | first 30 min after 24h+ absence |
| Live-Ops event XP | variable | per-event config |

### 2.4 Server-side storage & validation

**Never trust the client for tier or XP.** The client displays a *cached* view; the server is truth.

```jsonc
// PlayerPassProgress (per player, per season) — authoritative row
{
  "player_id": "u_88213",
  "season_id": "S14",
  "pass_id": "bp_s14",
  "owns_premium": true,          // set only by a verified Payment grant
  "total_xp": 84210,             // monotonic; server-computed
  "current_tier": 47,            // derived from total_xp via pass curve
  "claimed_free":    [1,2,3, ...],   // bitset/roaring-bitmap of claimed tiers
  "claimed_premium": [1,2,3, ...],
  "updated_at": "2026-08-20T09:14:02Z",
  "version": 512                 // optimistic-concurrency guard
}
```

**XP crediting flow (anti-cheat):**

1. Match ends → **Game Server** (authoritative sim, not the player's device) emits a signed
   `MatchResult{player_id, placement, kills, duration, checksum}` to the BattlePass Service.
2. BattlePass Service recomputes XP **from the server-side match result**, ignoring any client-claimed totals.
3. XP applied with an **idempotency key** = `match_id:player_id` so a replayed message can't double-credit.
4. `current_tier` is **derived**, never stored as the source of truth — a corrupted cache can't inflate tier.
5. Sanity rails: reject match XP if `duration < min_match_seconds`, if kills exceed lobby size, or if a
   player's XP/hour exceeds a statistical ceiling (flag for review, don't hard-ban on first offense).

**Claim flow:** client calls `POST /pass/claim {tier, track}`. Server checks:
`tier <= current_tier` AND (`track != premium` OR `owns_premium`) AND `tier not in claimed_<track>`.
On success it grants via Inventory/Wallet inside a **single Ledger transaction** and adds the tier to the
claimed set with an optimistic `version` bump. Double-claim races lose to the `version` guard and no-op.

---

## 3. Store & Monetization

### 3.1 Currencies

| Currency | Type | Earned? | Bought? | Refundable? | Expires? |
|---|---|---|---|---|---|
| **Sparks** (soft) | Soft | Yes (play) | No | No | No |
| **Prisms** (premium) | Hard | Small amounts via BP | Yes (IAP) | Per store policy / law | No |
| **Bound Prisms** | Promo/hard | Grants, refunds | No | No | Optional (e.g., 90 days) |
| **Event Tokens** | Event-scoped | Event play | No | No | End of event |

> **Legal note on currency separation:** we track **paid** Prisms (bought with money) separately from
> **earned/bound** Prisms in the Ledger. Several jurisdictions (and app-store consumer-protection rules)
> require that unspent *paid* balance be refundable on account closure. Bound Prisms are promotional and
> non-refundable, which must be disclosed at grant time. Spend order = **bound-first, then paid** so we
> minimize the refundable liability we're holding.

### 3.2 Prism packs (illustrative — real prices from store config, geo-priced)

| Pack | Prisms | Bonus | Approx USD |
|---|---|---|---|
| Handful | 100 | — | $0.99 |
| Pouch | 550 | +50 | $4.99 |
| Chest | 1200 | +150 | $9.99 |
| Vault | 2600 | +500 | $19.99 |
| Hoard | 6800 | +1800 | $49.99 |

### 3.3 Store item data model

```jsonc
// StoreListing — the sellable unit; separates "what you get" from "how it's priced/shown"
{
  "listing_id": "list_ashfall_bundle",
  "sku": "PHX.S14.ASHFALL.BUNDLE",     // stable, used by IAP + analytics
  "title": "Ashfall Elite Bundle",
  "type": "bundle",                     // single | bundle | currency | subscription | pass
  "contents": [
    { "grant_type": "cosmetic", "item_id": "skin_ashfall_rifle", "qty": 1 },
    { "grant_type": "cosmetic", "item_id": "emote_cinder_dance", "qty": 1 },
    { "grant_type": "currency", "currency": "prisms", "qty": 500 }
  ],
  "price": { "currency": "prisms", "amount": 1800 },
  "reference_price": 2400,              // struck-through "value" — must reflect a real prior price
  "iap_product_id": null,               // set if directly money-priced (else priced in Prisms)
  "purchase_limit": { "per_account": 1 },
  "ownership_gate": "not_owned",        // hide/greyout if already owned to avoid wasteful re-buys
  "visibility": { "start": "...", "end": "...", "segments": ["all"] },
  "featured_rank": 10,
  "compliance": { "is_randomized": false, "odds_table_id": null }
}
```

**Bundles** must dynamically **discount already-owned contents**: if a player owns the skin, either hide
the bundle, or reprice so they're never charged twice for something they own (store-policy requirement).

### 3.4 Limited-time offers (LTO), coupons, subscriptions

**LTO / personalized offers**

```jsonc
{
  "offer_id": "lto_welcome_back_u88213",
  "listing_id": "list_starter_value",
  "player_segment_rule_id": "seg_lapsed_7d_nonpayer",
  "discount_pct": 40,
  "expires_at": "2026-08-22T00:00:00Z",   // real deadline, honored server-side
  "max_impressions": 3,
  "one_time": true
}
```
Offers are **server-gated**: eligibility, discount, and expiry are validated at purchase, so a spoofed
client can't claim an expired or ineligible discount. Countdown timers must show the **true** remaining
time from the server — no fake "resetting" timers (see ethics §10).

**Coupons**
```jsonc
{ "code": "PHOENIXRISE", "type": "percent", "value": 20,
  "applies_to": ["type:bundle"], "min_spend": 0,
  "max_redemptions_total": 100000, "max_per_account": 1,
  "starts_at": "...", "ends_at": "...", "stackable": false }
```
Redemption is atomic and idempotent (`coupon_code:player_id` key); the counter decrements in the same
transaction as the grant so a race can't over-redeem.

**Subscription — "Phoenix Pass+" (monthly)**

| Benefit | Detail |
|---|---|
| Daily Prisms | 50/day claimed in-app (net > price if claimed most days) |
| BP XP | +20% permanent while active |
| Monthly cosmetic | 1 exclusive item drop |
| Store discount | 10% off Prism-priced cosmetics |

Subscriptions use the **platform's native billing** (App Store / Google Play auto-renew). We store
entitlement state keyed to the platform subscription, reconcile via server-to-server notifications
(renewal, cancellation, refund, grace period, billing retry), and **revoke benefits** when the platform
reports lapse. Cancellation and renewal-date disclosure follow each store's subscription rules.

### 3.5 Purchase → grant flow (idempotency, receipts)

```
Client                 Store Svc            Payment Svc          Platform Billing      Ledger/Inventory
  │  begin purchase(sku) │                     │                      │                    │
  │─────────────────────►│  reserve order      │                      │                    │
  │                      │────────────────────►│                      │                    │
  │  order_id ◄──────────│◄────────────────────│                      │                    │
  │  native purchase ─────────────────────────────────────────────────►│ (charge, receipt) │
  │  receipt ◄──────────────────────────────────────────────────────── │                    │
  │  POST /verify {order_id, receipt} ────────►│  validate receipt ───►│ (verify w/ Apple/  │
  │                      │                     │◄───────────────────── │  Google servers)   │
  │                      │                     │  idempotent grant ────────────────────────►│ write txn
  │  fulfilled ◄─────────│◄────────────────────│                      │                    │
```

**Guarantees:**

- **Server-side receipt validation only.** Receipts are verified against Apple/Google servers from our
  backend. A client-asserted "I paid" is never trusted.
- **Idempotency key = platform transaction id.** Re-sending the same receipt (retries, restore-purchases,
  network drops) grants exactly once. The grant and the "receipt consumed" mark commit in **one Ledger txn**.
- **Deferred / interrupted purchases:** if the app dies after charge but before grant, a background
  reconciler replays unconsumed receipts on next login (and via periodic sweep) so the player always gets
  what they paid for.
- **Refunds & chargebacks:** platform S2S refund notifications trigger a **compensating Ledger entry** and
  a clawback of the granted items/currency where policy and balance allow; consumed consumables are handled
  per refund policy and can drive a fraud score, not an instant ban.
- **Fraud:** velocity checks, receipt-replay detection across accounts, and refund-abuse scoring feed a
  review queue.

```jsonc
// LedgerEntry — the atom of economic truth (append-only, never updated)
{
  "entry_id": "led_01J...", "player_id": "u_88213",
  "txn_id": "txn_01J...", "type": "grant",       // grant | spend | refund | adjust
  "source": "iap", "source_ref": "GPA.1234-5678-...",  // platform txn id (idempotency)
  "deltas": [ {"currency":"prisms","amount":+1200},
              {"item_id":"skin_ashfall_rifle","amount":+1} ],
  "reason": "purchase:PHX.S14.ASHFALL.BUNDLE",
  "created_at": "2026-08-20T09:14:02Z"
}
```

---

## 4. Progression: Missions, Achievements, Leaderboards

### 4.1 Missions (data-driven)

```jsonc
// MissionDef — authored in Admin Dashboard, assigned by rotation
{
  "mission_id": "wk_hs_headshots", "scope": "weekly",   // daily | weekly | monthly | seasonal
  "title": "Sharpshooter", "description": "Land 50 headshots",
  "objective": { "metric": "headshots", "target": 50, "mode_filter": ["ranked","casual"] },
  "reward": { "bp_xp": 5000, "sparks": 200 },
  "reroll_cost": { "currency": "sparks", "amount": 50 },  // 1 free reroll/day
  "assign_rule": "random_from_pool:weekly_pool_s14"
}
```

| Scope | Count | Refresh | Purpose |
|---|---|---|---|
| Daily | 3 | 05:00 local | Habit / daily active loop |
| Weekly | 7 | Monday | Sustained weekly retention |
| Monthly | 4 | 1st | Long-tail, bigger rewards |
| Seasonal | ~15 | Per season | Completionist / lapsed catch-up |

Mission progress is credited from **server-side match telemetry** (same trusted `MatchResult` feed as BP XP),
never from client counters. Progress writes are idempotent per `match_id`.

### 4.2 Achievements

Permanent, account-level, cross-season. Grant one-time cosmetic/badge rewards. Stored as an append-only
set with `unlocked_at`. Good for onboarding funnels ("play 10 matches") and mastery ("1000 wins").

### 4.3 Leaderboards

| Board | Scope | Reset | Notes |
|---|---|---|---|
| Ranked ladder | Global + regional | Season | Top-500 get Phoenix titles |
| Event boards | Per event | Event end | Tie to event tokens |
| Squad boards | Friends | Weekly | Social retention |

Backed by a Redis sorted-set (hot, real-time reads) mirrored to durable storage for reward settlement.
**Anti-cheat:** scores derive only from validated match results; suspicious entries are shadow-frozen
pending review before rewards settle at period end.

---

## 5. Matchmaking-Adjacent Economy Concerns

The economy team does **not** own matchmaking, but our systems feed and constrain it. Two hard rules:

1. **Never sell competitive power.** Phoenix is cosmetics-only. Nothing purchasable changes damage, speed,
   health, or map info. This keeps matchmaking fair and avoids pay-to-win regulatory/community fallout.
2. **Skill-based matchmaking (SBMM) inputs are never purchasable and never leaked to the store.**

### 5.1 SBMM inputs (reference)

| Signal | Source | Notes |
|---|---|---|
| Hidden MMR | Match outcomes (per-mode) | Primary skill estimate (Glicko-style: rating + deviation) |
| Recent form | Last N matches | Dampens volatility |
| Party skill | Max/weighted party MMR | Prevents high player carrying a low lobby |
| Input method | Touch / controller | Optional pool separation for fairness |
| Ping / region | Network | Latency floor beats perfect skill match |
| New-player shield | Account age / matches | Protects first ~20 matches from veterans/smurfs |

### 5.2 Bot-filling policy (transparency)

Bots are a UX/retention tool, used **honestly**, not a monetization trick.

| Rule | Policy |
|---|---|
| When | Only to fill under-populated lobbies (off-peak, small regions) and to protect the new-player shield. |
| Disclosure | Bot presence is disclosed in the mode description; bots use a visible tell (e.g., no ranked crest). |
| Ranked integrity | **No bots in ranked** above the shield tiers. Ranked rewards must reflect real play. |
| Never | Bots are never tuned to bait purchases (e.g., easy kills after a store visit). That's a dark pattern (§10). |
| Economy | Bot kills grant **reduced** BP XP and **do not** count toward competitive missions/leaderboards. |

---

## 6. Reward & Drop Systems

### 6.1 Loot tables

```jsonc
// LootTable — reusable, referenced by crates, events, missions
{
  "table_id": "crate_ashfall_std",
  "rarity_weights": {                  // sums to 1.0; drives odds disclosure
    "common": 0.7492, "rare": 0.20, "epic": 0.045, "legendary": 0.0055,
    "mythic": 0.0003
  },
  "pity": { "enabled": true, "guarantee_rarity": "legendary", "hard_pity_pulls": 50 },
  "dupe_protection": { "policy": "convert", "to_currency": "prisms", "rate_by_rarity": {"epic": 20, "legendary": 80} },
  "pools": {
    "common":    ["spray_a","spray_b","charm_c"],
    "legendary": ["skin_phoenix_blade"],
    "mythic":    ["skin_ashfall_reactive"]
  }
}
```

**Drop mechanics:**
- **Weighted random** by rarity, then uniform within the chosen rarity pool (or per-item weights if needed).
- **Pity / hard-pity:** guaranteed legendary by the 50th pull. Prevents extreme bad luck; disclosed to players.
- **Duplicate protection:** dupes auto-convert to Prisms so the player is never given nothing they can use —
  strongly recommended for fairness and to avoid regulatory scrutiny.
- **Determinism & audit:** each pull logs `{table_id, table_version, rng_seed_ref, result_item, pity_counter}`
  to the Ledger so any pull can be reconstructed for dispute/audit.

### 6.2 Crates / lootboxes — transparency & compliance

> **Position:** Phoenix ships randomized crates only where they are **legal**, **cosmetic-only**, and
> **fully odds-disclosed**. In markets where paid lootboxes are restricted (e.g., Belgium; regimes with
> loot-box laws or where under-18 sale is limited), we **geo-disable paid randomization** and sell those
> cosmetics via **direct purchase** instead. This is a config flag, not a code change.

Mandatory compliance rules (enforced in code + store review):

| Requirement | Implementation |
|---|---|
| Odds disclosure | Exact percentages shown **before** purchase, generated directly from `rarity_weights`. Store-policy mandated (Apple/Google both require probability disclosure for randomized paid items). |
| Direct-purchase alternative | Every crate cosmetic is buyable directly (removes "must gamble" pressure). |
| No cash-out | Items and Prisms can never be converted to real money → not gambling by design. |
| Pity disclosed | Guarantee thresholds shown alongside odds. |
| Age gating | Paid randomization disabled for accounts flagged under-18 where required; parental controls respected. |
| No FOMO on odds | Odds are stable within an event; we never secretly worsen odds after a spend. |
| Duplicate value | Dupe→currency conversion disclosed so "you already own it" isn't a dead pull. |

```jsonc
// OddsDisclosure (auto-rendered in the pre-purchase UI, generated from LootTable)
{
  "table_id": "crate_ashfall_std", "table_version": 3,
  "rows": [
    {"rarity":"Common","chance":"74.92%"},
    {"rarity":"Rare","chance":"20.00%"},
    {"rarity":"Epic","chance":"4.50%"},
    {"rarity":"Legendary","chance":"0.55%"},
    {"rarity":"Mythic","chance":"0.03%"}
  ],
  "guarantee": "Legendary or higher by your 50th open."
}
```

---

## 7. Live-Ops Calendar & Events

### 7.1 Philosophy: config over code

An event is a **data document** authored in the Admin Dashboard, validated, versioned, signed, and
published to a CDN/config store. Clients and services fetch the active config; **shipping an event needs no
client build**. This lets Live-Ops run weekly events without app-store re-review.

```jsonc
// EventConfig
{
  "event_id": "evt_cinderfall_2026",
  "type": "score_race",             // score_race | collection | ltm | login | mission_chain
  "display": { "banner": "cdn://events/cinderfall/banner_v2", "title": "Cinderfall Clash" },
  "schedule": {
    "starts_at": "2026-09-01T17:00:00Z",
    "ends_at":   "2026-09-08T17:00:00Z",
    "timezone_display": "player_local",
    "phases": [ {"id":"qualify","ends_at":"2026-09-05T17:00:00Z"},
                {"id":"finals","ends_at":"2026-09-08T17:00:00Z"} ]
  },
  "currency": "event_tokens",
  "reward_track_id": "evt_cinderfall_track",
  "mission_pool_id": "evt_cinderfall_missions",
  "store_listings": ["list_cinderfall_bundle"],
  "targeting": { "segments": ["all"], "min_level": 5 },
  "feature_flags": { "ltm_mode": "cinder_rush", "double_xp": false },
  "ab_test_id": null,
  "rollout": { "type": "staged", "percent": 100 }
}
```

### 7.2 Calendar & scheduling

| Capability | Detail |
|---|---|
| Overlap | Multiple events can run concurrently (a login event + an LTM + a store sale). |
| Timezones | Store all times in **UTC**; display in player-local. A "daily reset" is per-region to be fair. |
| Staged rollout | `rollout.percent` + segments enable canary launches; bad configs roll back instantly. |
| A/B testing | `ab_test_id` splits a config into variants (price, reward, odds within legal bounds). |
| Kill switch | Every event has a server flag to disable it live without a deploy. |
| Dependency guard | Validator blocks publishing an event referencing a missing loot table / listing / bundle. |
| Audit | Every publish records author, diff, and timestamp (who changed the odds, when). |

### 7.3 Admin Dashboard responsibilities

- **Authoring:** WYSIWYG editors for seasons, passes, missions, loot tables, offers, events.
- **Validation:** schema + business rules (no negative prices, odds sum to 1.0, no orphan references,
  no cosmetic that grants power).
- **Approval workflow:** economy configs require a **second-person review + sign-off** before publish
  (four-eyes principle) — protects against a fat-fingered "0.03% → 30%" mistake or malicious change.
- **Scheduling & rollback:** calendar view, publish/unpublish, instant revert to a prior signed version.
- **Segmentation:** define player segments (spend tier, tenure, region, churn risk) for targeting.

---

## 8. Analytics & KPIs

### 8.1 Core KPIs

| Category | Metric | Definition | Why it matters |
|---|---|---|---|
| Retention | D1 / D7 / D30 | % returning on day N after install | Health of the core loop |
| Retention | Rolling retention | Returned on/after day N | Smooths noise |
| Engagement | DAU / MAU / **stickiness** | DAU÷MAU | Habit strength |
| Engagement | Session length & count | Minutes/session, sessions/day | Depth of the loop |
| Monetization | **ARPU / ARPDAU** | Revenue ÷ users | Overall monetization |
| Monetization | **ARPPU** | Revenue ÷ paying users | Spender value |
| Monetization | **Conversion** | % of users who ever pay | Top-of-funnel monetization |
| Monetization | **LTV** | Predicted lifetime revenue/user | Governs UA spend |
| Monetization | Repeat-purchase rate | % of payers buying 2nd+ | Post-first-buy health |
| Progression | BP attach rate | % buying the premium pass | Core product KPI |
| Progression | BP completion | % of buyers finishing | Value delivery / fairness signal |
| Economy | Currency source/sink balance | Inflow vs outflow of Sparks/Prisms | Detects inflation |
| Economy | Faucet-drain per feature | Where currency enters/leaves | Tuning levers |
| Quality | Crash-free sessions, match abandon rate | | Retention drivers |

> **Whale-dependency guardrail:** we track **revenue concentration** (share of revenue from the top 1% /
> 0.1% of spenders) and **spend velocity per account**. If a tiny cohort's spend or velocity spikes
> abnormally, we surface it for **player-wellbeing review** (possible addiction/fraud), not for
> "how do we extract more." This is an explicit anti-goal on our dashboards.

### 8.2 Instrumentation

Every economic event emits a typed analytics record (offer shown / clicked / purchased / abandoned,
crate opened + result, BP tier claimed, mission completed). These power A/B analysis, LTV models, funnel
analysis, and fraud detection. PII is minimized and handled per privacy policy / GDPR / CCPA; children's
data handling follows COPPA / age-appropriate design where applicable.

---

## 9. Reference Data Contracts (summary)

| Object | Owner | Key | Mutability |
|---|---|---|---|
| `SeasonConfig` | Live-Ops | `season_id` | Immutable once live (new version to change) |
| `BattlePassDef` | Economy | `pass_id` | Immutable once live |
| `PlayerPassProgress` | BattlePass Svc | `player_id+season_id` | Server-write only, versioned |
| `StoreListing` | Monetization | `listing_id` | Versioned; live edits via new version |
| `LootTable` | Economy | `table_id` | Versioned; odds changes are audited |
| `EventConfig` | Live-Ops | `event_id` | Versioned; kill-switchable |
| `LedgerEntry` | Platform | `entry_id` | **Append-only, immutable** |
| `MissionDef` | Live-Ops | `mission_id` | Versioned |

---

## 10. Ethical & Compliant Monetization Guidance

This is a **hard requirement**, not a suggestion. Live-Ops proposals that violate these are rejected in review.

### 10.1 We DO

- **Cosmetics-only monetization.** No pay-to-win, ever. Skill rewards are earned, not sold.
- **Full odds disclosure** for any randomized paid item, with pity thresholds and dupe protection.
- **Honest timers & scarcity.** Countdowns reflect real server deadlines; "limited" means limited.
- **Direct-purchase alternatives** to every randomized item.
- **Currency clarity.** Show real-money reference where sensible; avoid confusing multi-currency mazes.
- **Earn-back loops** (BP returns premium currency) so engaged players feel rewarded, not milked.
- **Refund & subscription rights** per each store's rules and local consumer law; easy cancellation.
- **Spend-awareness features** where required/appropriate: purchase confirmation, session/spend reminders,
  optional self-imposed spend limits, parental controls, no purchasing without authentication.
- **Age-appropriate design.** Restrict/disable paid randomization for minors where required.

### 10.2 We DON'T (banned dark patterns)

| Dark pattern | Why it's banned |
|---|---|
| Pay-to-win / sold power | Destroys fairness, invites regulation and community revolt |
| Fake / resetting countdown timers | Deceptive; violates consumer-protection law and store policy |
| Hidden or post-hoc-worsened odds | Deceptive; violates odds-disclosure requirements |
| Bait-the-whale bot lobbies / rigged difficulty near the store | Manipulative, erodes trust |
| Confusing currency layers designed to obscure real cost | "Disguised cost" dark pattern |
| Pressuring or nagging minors; no spend limits for at-risk spenders | Harm + legal exposure |
| Non-consensual auto-renew / hard-to-cancel subscriptions | Violates store & consumer rules |
| "Item already owned" still sold at full price with no warning | Wastes player money; store-review risk |

### 10.3 App-store & regulatory compliance checklist

- [ ] Randomized paid items disclose exact odds **before** purchase (Apple & Google requirement).
- [ ] Use **platform-native IAP** for digital goods; no off-platform payment steering where prohibited.
- [ ] Subscriptions disclose price, renewal terms, and cancellation clearly.
- [ ] Receipts validated **server-side**; purchases idempotent and reconciled.
- [ ] Paid currency refundable per policy/law on account closure; bound currency disclosed as non-refundable.
- [ ] Geo-config disables paid lootboxes where restricted; direct purchase substituted.
- [ ] Privacy (GDPR/CCPA), children's data (COPPA / age-appropriate codes) respected in all telemetry.
- [ ] Loot-box / disclosure legislation monitored per region; configs adjustable without a client build.
- [ ] Second-person sign-off on any pricing/odds change before publish.

---

*End of document. Changes to seasons, passes, store, loot, or events are made via versioned config in the
Admin Dashboard under the four-eyes review policy — not via code deploys.*
