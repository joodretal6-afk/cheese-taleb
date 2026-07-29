# 08 — Security & Anti-Cheat

> **Scope.** This document defines the security architecture for Project Phoenix:
> identity, authorization, the server-authoritative game model, anti-cheat
> detection, ban infrastructure, transport/packet security, payment & economy
> fraud prevention, replay validation, and a consolidated threat model.
>
> **Stack context.** Backend is NestJS + TypeScript microservices over
> PostgreSQL, Redis, and Kafka, talking gRPC/REST/WS. The game client is UE5
> (Android / iOS / Windows dev). Dedicated game servers ("match servers") are
> the authoritative simulation for a live match. Everything here assumes the
> **client is hostile** — it runs on hardware the attacker fully controls.

---

## 0. Guiding principles

1. **The client is an untrusted input device.** It renders and it sends intent.
   It never decides outcomes. Anything the client asserts is a *request*, not a
   *fact*.
2. **Server-authoritative by default.** If a game or economy outcome matters, a
   server computes it. The client's copy is a prediction that the server can
   overrule.
3. **Defense in depth.** No single control is trusted to be unbreakable —
   especially on mobile, where the OS itself can be rooted/jailbroken. We layer
   cheap client signals under strong server-side validation.
4. **Detection over prevention where prevention is impossible.** We cannot stop
   a rooted device from reading its own memory. We *can* make cheating
   statistically visible and expensive, and ban reliably.
5. **Fail closed for money and identity; fail open for UX where safe.** A
   doubtful payment is held; a doubtful movement packet is clamped, not
   necessarily kicked.
6. **Least privilege everywhere.** Services, admins, and tokens get the minimum
   scope needed, time-boxed.

---

## 1. Authentication & Authorization

### 1.1 Identity model

| Concept | Meaning |
| --- | --- |
| **Account** | The durable identity (`account_id`, UUID v7). Owns entitlements, currency, ban state. |
| **Credential** | A way to prove control of an account: password, OAuth link, Firebase identity, passkey. An account may have several. |
| **Device** | A physical install (`device_id`), bound to sessions and used for device-ban and 2FA trust. |
| **Session** | A time-boxed authenticated context, represented by a refresh token family + short-lived access tokens. |

### 1.2 Primary auth: Auth service (first-party)

The Auth service (`services/auth`) is the system of record. It issues our own
tokens regardless of how the user proved identity, so downstream services only
ever validate **one** token format.

**Token types**

| Token | Format | Lifetime | Storage (client) | Purpose |
| --- | --- | --- | --- | --- |
| **Access token** | JWT (EdDSA / Ed25519), `RS`-free | **15 min** | In-memory only | Bearer for REST/WS/gRPC calls |
| **Refresh token** | Opaque 256-bit random, hashed at rest | **30 days** sliding | Secure storage (Keychain / Keystore) | Obtain new access tokens |
| **Match ticket** | Short JWT, audience = specific match server | **≤ 2 min**, single-use | In-memory | Join a dedicated game server |
| **Admin access token** | JWT, separate signing key, `aud: admin` | **10 min** | httpOnly + Secure + SameSite=Strict cookie | Admin dashboard |

**Access token claims (JWT)**

```jsonc
{
  "iss": "phoenix-auth",
  "sub": "<account_id>",           // UUID v7
  "aud": "phoenix-game",           // or "admin", "match:<server_id>"
  "sid": "<session_id>",           // ties token to a refresh family
  "did": "<device_id_hash>",       // device binding, see 1.6
  "roles": ["player"],             // RBAC, see 1.7
  "ent": "e:1730",                 // entitlement epoch (cache-bust on change)
  "iat": 1753000000,
  "exp": 1753000900,               // iat + 15m
  "jti": "<uuid>"                  // for targeted revocation
}
```

- **Signing:** EdDSA (Ed25519). Keys live in KMS/HSM; the JWKS is published at
  `/.well-known/jwks.json` and cached by services. **Key rotation every 90 days**
  with overlapping validity (two active `kid`s) so no token is orphaned.
- **Verification:** stateless. Every service validates signature, `exp`, `aud`,
  and `iss` locally against cached JWKS — no round-trip to Auth on the hot path.
- **`alg` is pinned** server-side. We reject `alg: none` and any RSA/HMAC
  confusion by only accepting the `kid`s in our JWKS with their declared alg.

### 1.3 Refresh tokens & rotation

- Refresh tokens are **opaque random**, never JWTs. Stored server-side as a
  SHA-256 hash in a `refresh_tokens` table keyed by `session_id` (the "family").
- **Rotation on every use.** Each refresh call issues a new refresh token and
  invalidates the presented one.
- **Reuse detection.** If an *already-rotated* (consumed) refresh token is
  presented again, it means the token leaked and two parties hold it. We
  **revoke the entire family** (log the user out on all devices for that
  session) and raise a security event. This is the standard OAuth
  refresh-token-rotation replay defense.
- **Sliding expiry** capped at an absolute max of **90 days**; after that the
  user re-authenticates.
- Refresh state lives in PostgreSQL (durable) with a Redis cache of "revoked
  jti / revoked family" for fast access-token denylisting between the 15-min
  windows.

### 1.4 Access-token revocation

Short lifetimes mean we mostly *let tokens expire*. For the cases that can't
wait 15 minutes (ban, forced logout, credential change):

- A **Redis denylist** of `jti` and `sid` (TTL = remaining token lifetime) is
  checked by a lightweight guard on sensitive routes and on **every match-join**.
- Match servers re-check ban/denylist at join, so a ban takes effect at the next
  match boundary at worst, immediately for new joins.

### 1.5 Social / federated login

Three optional login paths, all funneled into first-party tokens:

1. **OAuth 2.0 / OIDC** — Google, Apple (required for iOS), and (optionally)
   platform accounts. **Authorization Code + PKCE only**; implicit flow is not
   used. We validate the ID token signature, `iss`, `aud`, `nonce`, and expiry.
   Apple's "Hide My Email" relay is supported.
2. **Firebase Authentication (option).** For teams/regions that prefer it,
   Firebase can front phone-OTP and social login. Our Auth service verifies the
   **Firebase ID token** against Google's public keys, then **exchanges it for
   Phoenix tokens.** Firebase is an identity provider only — it is *not* our
   session or authorization system. This keeps a single token model downstream
   and avoids coupling game/economy authz to a third party.
3. **Guest → account upgrade.** Guests get a device-bound account with a
   downgraded trust tier (no store purchases, limited social) until they attach a
   real credential.

**Account linking** is explicit and re-auth-gated: linking a new provider to an
existing account requires a fresh authentication (and 2FA if enabled) to prevent
account-takeover-by-linking.

### 1.6 Session management & device binding

- **Device identity.** On first launch the client generates a keypair in secure
  hardware where available (Android Keystore / iOS Secure Enclave). The public
  key + a coarse device fingerprint form `device_id`. The access token carries a
  **hash** of it (`did`).
- **Binding.** Refresh tokens are pinned to a `device_id`. Presenting a refresh
  token from a different device fingerprint is treated as suspicious → step-up
  auth or family revocation, per risk score.
- **Session inventory.** Users can view active sessions (device, region, last
  seen) and remotely revoke any — this deletes the refresh family and denylists
  live access tokens.
- **Concurrency.** One live *match* session per account. A second match-join
  evicts the first (anti account-sharing / anti-boosting signal).
- **Honest limit:** device fingerprints on mobile are **soft**. A determined
  attacker can regenerate them (factory reset, emulator re-provision). Device
  binding raises cost and feeds risk scoring; it is not a hard identity.

### 1.7 RBAC for the Admin Dashboard

Admin authorization is a strict, auditable RBAC layer, **separate signing key and
audience** from game tokens so a leaked game token can never touch admin APIs.

| Role | Representative permissions |
| --- | --- |
| `support.l1` | Read player profile, read match history, issue warnings, read-only economy |
| `support.l2` | L1 + issue temp bans, reverse a single fraudulent transaction (dual-control), grant compensation within cap |
| `anticheat.analyst` | Review flagged accounts, watch replays, apply/lift bans, manage detection thresholds (staged, not live) |
| `economy.ops` | Manage store items, prices, promotions (all changes require second approver) |
| `liveops` | Events, battle pass config, feature flags |
| `admin.super` | User/role management, key rotation triggers, break-glass |
| `readonly.audit` | Read everything, change nothing (for auditors/security) |

Enforcement details:

- **Permission checks are server-side** on every admin endpoint (NestJS guards +
  a policy layer). The React dashboard hides controls for UX only — it is never
  the authorization boundary.
- **Dual control (4-eyes)** on high-impact actions: price changes, mass grants,
  currency mints, permanent bans over a threshold, refunds above a cap. One
  operator proposes, another approves.
- **Every admin action is written to an append-only audit log** (`admin_audit`,
  Kafka → immutable store) with actor, target, before/after, request ID, and IP.
- **2FA is mandatory for all admin roles** (see 1.8). Admin access is additionally
  **IP-allowlisted / behind SSO + VPN** for staff.
- **Break-glass** (`admin.super`) actions page the security team and are
  time-boxed.

### 1.8 Two-Factor Authentication (2FA)

| Factor | Where used | Notes |
| --- | --- | --- |
| **TOTP (RFC 6238)** | Players (optional), Admins (mandatory) | Authenticator apps; secret shown once, stored encrypted |
| **Passkeys / WebAuthn** | Admins (preferred), players (offered) | Phishing-resistant; preferred over TOTP for staff |
| **Email / SMS OTP** | Step-up on risky events | SMS is a **fallback only** — SIM-swap risk; never the sole factor for admins |
| **Recovery codes** | All 2FA users | 10 single-use codes, hashed at rest |

- 2FA is enforced at **login** and as **step-up** for sensitive actions
  (linking a provider, changing email/password, first purchase from a new
  device, large currency spend).
- **Rate limiting + lockout** on OTP verification (see §5.3) to stop brute force.
- Disabling 2FA requires the current second factor and triggers a 24h
  "security hold" on high-value actions.

---

## 2. Server-Authoritative Design

### 2.1 The principle

> In a match, the **dedicated game server owns the truth.** The client sends
> *inputs and intentions*; the server simulates, resolves, and broadcasts
> *results*. The client predicts locally for responsiveness but is continuously
> **reconciled** to server state and can be overridden at any tick.

This is the single most important anti-cheat control. Most "cheats" are just the
client lying about state; if the client's word is never taken, whole categories
of cheat (god mode, item duplication, instant-kill) simply cannot exist.

### 2.2 What "server-authoritative" means concretely for a BR

| System | Client sends | Server decides / validates | Client is *never* trusted to say |
| --- | --- | --- | --- |
| **Movement** | Input vector, look direction, timestamped intent | Applies physics on server tick; clamps to max speed/accel for current state (sprint/prone/vehicle); validates against collision & terrain | "I am at position X" |
| **Hit registration** | "I fired at time T aiming at direction D" | Server does the raycast/hitscan (or lag-compensated rewind) against **its** positions; computes damage, applies armor/falloff | "I hit player Y for N damage" / "Y is dead" |
| **Damage & health** | nothing authoritative | Server owns HP, shields, healing, downed/revive state | "My HP is full" / "I have god mode" |
| **Loot & inventory** | "I want to pick up item at container C slot S" | Server verifies proximity, that the item exists, isn't already taken, fits inventory; then transfers | "I now own item Z" |
| **Weapons & ammo** | fire/reload intents | Server tracks ammo, magazine, fire-rate, recoil seed; rejects impossible sequences | "I have infinite ammo" |
| **Zone / storm** | nothing | Server computes zone position/timing/damage centrally | anything about the zone |
| **Economy (currency, XP, BP)** | nothing authoritative | Server grants based on **its** recorded match results | "I earned 10,000 coins" |
| **Vehicles** | throttle/steer input | Server simulates vehicle physics, fuel, seat ownership | position/speed of the vehicle |

### 2.3 Client prediction & reconciliation (why it still feels good)

- The client runs **local prediction** for its own movement and a **rewind/
  interpolation** buffer for other players, so gameplay is smooth despite the
  server being authoritative.
- The server sends periodic **authoritative snapshots**. On mismatch the client
  **corrects** (rubber-bands). Frequent large corrections for one player are
  themselves an anti-cheat signal (§3.2).
- **Lag compensation:** the server rewinds other players to the shooter's
  perceived time when resolving a shot, within a bounded window (e.g. ≤ 250 ms).
  Shots claiming latency outside that window are rejected — this both protects
  fairness and blocks "fake lag" exploits.

### 2.4 Match server ↔ backend trust boundary

- Dedicated game servers run in **our** infrastructure (K8s), not on player
  hardware. They authenticate to backend services with **mTLS + a signed server
  identity**, not player tokens.
- Match **results** are signed by the match server and delivered to the economy
  service over an internal, authenticated channel (Kafka topic with schema +
  producer identity). The client is not in this loop, so it cannot forge rewards.

---

## 3. Anti-Cheat

Anti-cheat splits into three tiers, strongest first:

1. **Server-side validation** — impossible states are simply rejected. (Strong.)
2. **Server-side statistical detection** — plausible-but-anomalous behavior is
   scored and flagged for action. (Strong-ish; catches subtle cheating.)
3. **Client integrity checks** — best-effort signals from a hostile device.
   (Weak on mobile; used as *input to scoring*, never as sole proof.)

### 3.1 Detection is a pipeline, not a single check

```
match server telemetry ──► Kafka ──► Anti-Cheat service
       (per-tick + events)              │
                                        ├─ hard validators  → reject/clamp in-match
                                        ├─ heuristics        → per-match flags
                                        └─ batch models      → cross-match risk score
                                                                     │
                                                              ┌──────┴───────┐
                                                         auto-action     analyst queue
                                                       (high confidence)  (review + replay)
```

Every account carries a **risk score** aggregated across matches, devices, and
reports. Actions escalate with confidence: silent-flag → shadow matchmaking →
temp ban → permanent ban.

### 3.2 Movement cheats — speed hack / teleport / fly

Because movement is server-simulated (§2.2), these are mostly **prevented**, with
detection for the residue:

| Cheat | Server-side control |
| --- | --- |
| **Speed hack** | Server clamps velocity to the max for the current movement state; distance/time between authoritative ticks is bounded. Excess input is discarded, not applied. Repeated clamping → flag. |
| **Teleport** | Position deltas exceeding `max_speed × Δt + tolerance` are rejected; player stays at last valid position. Frequency of rejects is scored. |
| **Fly / noclip** | Server validates against collision geometry and ground/gravity; positions off the navmesh/inside geometry are invalid. |
| **Time manipulation** | Server owns the tick clock. Client timestamps are only used for lag comp within a bounded window; out-of-window or non-monotonic timestamps are rejected. |

Signal used for scoring: rate of position corrections, count of clamped ticks,
variance of client-reported vs server-computed position.

### 3.3 Aim cheats — aimbot / impossible accuracy / triggerbot

Aimbot is the hard one, because "aim well" is legitimate. We treat it as
**statistical anomaly detection over server-observed data**:

| Signal | What we measure (server-side) |
| --- | --- |
| **Accuracy vs population** | Hit % and headshot % per weapon-class, bucketed by range, vs the skill-bucket distribution. Sustained multi-sigma outliers are suspicious. |
| **Snap kinematics** | Angular velocity / acceleration of aim onto a target just before firing. Aimbots produce inhuman snap profiles (near-instant lock, zero overshoot, robotic settle). |
| **Target-switch latency** | Time to reacquire after a new target becomes visible; sub-human reaction across many samples. |
| **Through-cover pre-aim** | Aiming precisely at targets not yet legitimately visible (correlate with relevancy data from §3.5 — did the server ever send that position?). |
| **Consistency** | Humans vary; bots are eerily consistent. Low variance in tracking error is a flag. |
| **Fire discipline** | Firing exactly on the frame a hitbox is crossed (triggerbot) with impossible reaction times. |

- **Fire-rate & recoil validation (hard):** the server enforces each weapon's
  cooldown, magazine size, reload time, and recoil pattern seed. A client firing
  faster than the weapon allows, or with no recoil where recoil is mandatory, is
  **rejected and flagged** — this is a validator, not a heuristic, so no-recoil
  and rapid-fire macros are hard-blocked.
- Aim detection outputs a **probability**, feeding the risk score and the analyst
  queue. High-confidence cases can auto-ban; borderline cases get human +
  replay review (§7) to avoid false-positive bans on genuinely skilled players.

**Honest limit:** a *humanized* aim assist (adds jitter/delay) can approach the
human distribution. We counter with volume (many samples across many matches
converge), cross-signal correlation, and replay review — not with a magic single
detector.

### 3.4 Wallhack / ESP — mitigate by not sending the data

The most effective wallhack defense is architectural: **don't transmit
information the client has no legitimate need to render.**

- **Server-side relevancy / interest management.** For each player, the server
  computes what they can *plausibly* perceive (potentially-visible set:
  frustum + range + occlusion/PVS + audio radius) and **only replicates entities
  in that set.** An enemy behind a wall, out of range, or off-screen is **not in
  the packet at all** — so a memory-reading ESP has nothing to read.
- This is the single biggest lever against wallhacks/ESP on an untrusted client.
  If the data isn't there, no client hack can reveal it.

**Honest limits & tradeoffs:**

- Relevancy can't be *too* tight or players "pop in" late and gameplay suffers.
  We tune a safety margin — and that margin is exactly what a sophisticated ESP
  exploits (it sees enemies a beat before they'd naturally appear).
- Some info must be pre-sent for smoothness (footstep audio sources, nearby
  players about to round a corner). We minimize it and **detect** exploitation:
  pre-aiming/pre-firing at entities only just made relevant (§3.3) correlates ESP
  usage with the relevancy timeline the server itself controls.
- **Sound ESP** (visualizing audio) is mitigated by sending audio events as
  gameplay events resolved with limited positional precision, not full transforms.

### 3.5 Other in-match validators

- **Loot/inventory:** proximity, existence, ownership, and capacity are checked
  server-side; duplication and remote pickup are structurally impossible.
- **Damage/heal:** all state transitions (heal, revive, armor) are server events
  with cooldowns and preconditions; "insta-heal" is rejected.
- **Grenades/throwables:** trajectory simulated server-side from throw intent;
  client cannot specify the impact point.

### 3.6 Client integrity checks (tier 3 — and their limits)

We collect **client-side signals**, but treat them as *low-trust risk inputs*,
never as authoritative proof, because on a rooted/jailbroken device the client
can lie about all of them.

| Signal | Purpose | Limit |
| --- | --- | --- |
| **Root / jailbreak detection** | Elevate risk; gate high-trust features | Trivially spoofable on a rooted device; hides itself (Magisk DenyList, etc.) |
| **Emulator / debugger / hooking framework detection** (Frida, Xposed, GameGuardian signatures) | Flag common cheat tooling | Cat-and-mouse; new tools/renames evade |
| **Play Integrity API (Android) / DeviceCheck & App Attest (iOS)** | Platform-attested "genuine app on genuine OS" | Strong-ish on iOS; on Android, meaningful but bypassable on some devices; not available/absent = risk signal, not a ban |
| **Binary/asset checksum & anti-tamper** | Detect modified APK/IPA or patched binary | Determined attacker re-signs and patches the check itself |
| **Memory-integrity / anti-hook self-checks** | Detect in-process tampering | Runs in the attacker's process; can be neutralized |
| **Client heartbeat/telemetry consistency** | Cross-check client claims vs server observations | Only useful because the *server* holds the truth to compare against |

**Stated honestly:**

> **Client-side anti-cheat on mobile is fundamentally imperfect.** The code runs
> on hardware the attacker owns; given enough effort, any purely client-side
> check can be bypassed, spoofed, or removed. We use these signals to **raise the
> cost** of cheating and to **feed risk scoring**, but our real defense is
> server-authority + server-side statistical detection. We deliberately **do not**
> ship an invasive kernel-level anti-cheat: it is not viable on iOS's sandbox, is
> hostile to user trust and battery, and is not where the leverage is for a
> server-authoritative BR.

Where available we lean on **platform attestation** (App Attest / Play Integrity)
as the strongest client signal, because it is rooted in hardware/OS the attacker
does *not* fully control — but we still design as if it can be absent or bypassed.

---

## 4. Ban Infrastructure

### 4.1 Ban types

| Type | Keyed on | Use case | Notes / limits |
| --- | --- | --- | --- |
| **Account ban** | `account_id` | The default sanction | Cheap for the attacker to evade by making a new account — hence the layers below |
| **Device / HWID ban** | Device fingerprint(s), attestation key, install id | Stop the same physical device re-offending | Mobile "HWID" is soft; factory reset / new device evades. We store *sets* of correlated device signals, not one value |
| **IP ban** | IP / subnet | Blunt, temporary tool | High collateral (CGNAT, shared mobile IPs, campus/cafe). Used **short-term and narrowly**, mostly as a rate/geo signal, rarely as a standalone permanent ban |
| **Payment-instrument ban** | Hashed card/PSP token, wallet id | Repeat chargeback/fraud actors | Coordinated with PSP; see §6 |
| **Shadow ban** | `account_id` (silent) | Suspected but not proven; anti-appeal-farming | Player keeps "playing" but is matched into a **quarantine pool** (other suspected cheaters / bots), sees degraded impact, earns nothing durable |
| **Cluster ban** | Risk-graph component | Ban a ring of linked accounts/devices at once | Powered by the association graph (§4.3) |

Bans carry `{type, scope, reason_code, evidence_ref, duration, issued_by,
issued_at, expires_at, appeal_state}` and are event-sourced in Postgres +
mirrored to Redis for fast enforcement at login/match-join.

### 4.2 Enforcement points

- **Login / token refresh:** banned accounts can't get fresh tokens.
- **Match-join:** the match server re-checks account + device + risk before
  admitting a player (catches bans issued mid-session).
- **Store / economy:** payment and shadow bans block purchases and withdrawals.
- **Live denylist in Redis** so a ban is effective within seconds, not at token
  expiry.

### 4.3 Ban-evasion handling

Evasion is expected; we make it **expensive and detectable** rather than pretend
it's impossible.

- **Association graph.** A graph service links accounts via shared devices,
  attestation keys, payment instruments, IP history, refresh-family lineage, and
  behavioral fingerprints (playstyle, input cadence). New accounts that light up
  next to a banned cluster inherit elevated risk and can be **auto-quarantined
  (shadow)** pending confirmation.
- **New-account trust tier.** Fresh accounts start low-trust: limited purchases,
  restricted social, and preferentially matched away from established players
  until they build history. This blunts the value of a throwaway account.
- **Attestation continuity.** Because platform attestation is hard to forge, a
  device that keeps producing banned-then-new accounts is strongly linkable even
  after resets.
- **Purchase friction for repeat evaders.** Payment-instrument reuse across
  banned accounts is a high-signal link (§6).

**Honest limit:** a motivated cheater with a new device, new account, new
payment method, and a VPN *can* get back in. Our goal is to make each re-entry
costly, short-lived, and quickly re-detectable via behavior — turning a one-time
ban into an ongoing tax on the cheater.

### 4.4 Appeal flow

Bans are actioned by systems and humans, so we provide due process — this also
protects us from false-positive damage (§3.3).

```
Player receives ban notice (reason_code + generic category, NOT the exact
   detection detail — we don't teach cheaters our thresholds)
        │
        ▼
Player files appeal (in-app / web form)  ── rate-limited, one open appeal at a time
        │
        ▼
Auto-triage: pull evidence bundle (replay refs, validator hits, risk score,
   association links) into an analyst case
        │
        ├─ Clear-cut cheat (hard-validator + high confidence) → templated denial
        │
        ├─ Ambiguous → human analyst reviews REPLAY (§7) + signals
        │        ├─ upheld  → explain category, offer nothing further
        │        └─ overturned → lift ban, restore state, root-cause the false positive
        │
        └─ Second-level / escalation for permanent bans (different reviewer, 4-eyes)
```

- Appeals, decisions, and evidence are logged for audit and to **measure false-
  positive rate** — a key health metric for the detection team.
- We **never disclose exact detection logic** in appeals (would be a cheat-tuning
  oracle), only the reason category.

---

## 5. Packet & Transport Security

### 5.1 Encryption / TLS

| Channel | Transport | Notes |
| --- | --- | --- |
| Client ↔ REST/WS backend | **TLS 1.3** | HSTS, modern ciphers only; cert pinning in the client (with a backup pin + rotation plan to avoid bricking) |
| Client ↔ match server (realtime) | **DTLS 1.3 / encrypted UDP** | Game traffic is UDP for latency; encrypted + authenticated per-session key negotiated at join |
| Service ↔ service (internal) | **mTLS** | gRPC/Kafka between microservices; SPIFFE-style workload identity |
| Match server ↔ backend | **mTLS + signed server identity** | Match results/telemetry authenticated |

- **Cert pinning** on mobile stops trivial MITM/proxy inspection of traffic
  (raising the bar for packet-crafting cheats). We ship **two pins** (primary +
  next) and rotate ahead of expiry to avoid client bricking — an honest
  operational tradeoff of pinning.

### 5.2 Realtime packet protection

- **Per-session symmetric key** derived at match join (from the match ticket);
  every game packet is **authenticated (AEAD)** so forged/tampered packets are
  dropped.
- **Sequence numbers + nonces** on every packet.
- **Replay protection:** a sliding-window (bitmap) of recently-seen sequence
  numbers per session rejects duplicates and out-of-window packets. Nonces are
  never reused under a key (AEAD requirement); keys are per-match, so cross-match
  replay is impossible.
- **Anti-amplification / connection validation** at join (cookie handshake) to
  resist spoofed-source UDP floods.

### 5.3 Rate limiting & abuse control

Enforced at the edge (API gateway / Envoy) **and** per-service, because the edge
alone can be bypassed for internal calls:

| Surface | Limit style |
| --- | --- |
| Auth (login, OTP, refresh, password reset) | Strict per-account + per-IP + per-device sliding window; exponential backoff + lockout on OTP |
| Store / purchase | Per-account velocity caps (count + value per hour/day) |
| Matchmaking / join | Per-account and per-device |
| Social (friend req, chat, reports) | Per-account with anti-spam heuristics |
| General API | Token-bucket per token + per-IP; 429 with `Retry-After` |

Distributed counters in Redis; limits are tunable via LiveOps without a deploy.

### 5.4 Input validation

- **Every external input is validated** at the boundary: NestJS DTOs with
  `class-validator`, strict schemas (allow-list, typed, bounded ranges/lengths),
  reject-unknown-fields.
- **Realtime inputs** are range/sanity-clamped on the match server (movement
  magnitude, look deltas, action frequencies) before simulation.
- Parameterized queries / ORM only (no string-built SQL) → SQL-injection safe.
- Output encoding + CSP on web surfaces (Admin, Map Editor) → XSS defense.
- IDs are opaque UUIDs and **authorization is checked per object** (no IDOR:
  "can *this* account act on *this* resource?").

---

## 6. Payment & Economy Security / Fraud Prevention

Money is where we **fail closed**. Two distinct risks: (a) *payment fraud*
(stolen cards, chargebacks) and (b) *economy manipulation* (dupes, RMT, boosting).

### 6.1 Payment integrity

- **Store purchases are validated server-side against the platform.** iOS
  (App Store Server API / signed `JWSTransaction`) and Android (Play
  Billing / `purchases.products` verification) receipts are verified on **our**
  server before granting entitlements. A client claiming "I bought X" grants
  nothing until the platform confirms it. This kills receipt-forgery / local
  IAP-patch cheats.
- **Idempotency keys** on grant so a retried/duplicated purchase callback grants
  once.
- **Entitlements are server-owned;** the client only *displays* them (`ent`
  epoch in the JWT busts caches on change).
- **3-D Secure / SCA** for direct card flows via the PSP; we never touch raw
  PAN (PSP tokenization, PCI-DSS scope minimized).

### 6.2 Fraud detection

| Vector | Control |
| --- | --- |
| **Stolen cards / chargeback fraud** | PSP risk scoring + our velocity rules (new account + high spend + new device + geo mismatch = hold/step-up). Chargeback → auto-suspend entitlements & flag account |
| **Refund abuse** | Track refund rate per account/instrument; repeat refunders lose instant-grant / go manual review |
| **Currency duplication** | Impossible by design: currency lives in a **single-writer ledger** (double-entry, append-only) in the economy service; grants/spends are transactional |
| **RMT (real-money trading) / account selling** | Detect via trade/gift graphs, login-region churn, device sharing; restrict trading; devalue trading paths |
| **Boosting / account sharing** | Session concurrency limits + device-binding anomalies + skill-vs-history discontinuities |
| **Promo / referral abuse** | Dedup by device+payment+association graph; caps and cooldowns |

### 6.3 Economy ledger

- All currency and durable rewards are recorded in an **append-only, double-entry
  ledger**. Balances are derived; you cannot "set" a balance, only post
  transactions — so audits reconcile and dupes are structurally visible.
- **Grants come only from trusted producers** (verified purchase, signed match
  result, admin action with 4-eyes). The client is never a producer.
- **Admin currency mints/grants require dual control** and are audit-logged
  (§1.7).

---

## 7. Replay Validation for Reported Matches

We record enough to **deterministically re-examine** any match without trusting
any client.

### 7.1 What we store

- Match servers write a **compact, authoritative event/input log** per match
  (server-observed inputs, RNG seeds, authoritative snapshots at interval) to
  object storage, keyed by `match_id`, retained for a bounded window (longer for
  flagged/reported matches).
- Because the sim is **deterministic** given seeds + the server-recorded input
  stream, we can **re-simulate** the match server-side and get the same outcome —
  and inspect it frame-by-frame.

### 7.2 How it's used

| Trigger | Flow |
| --- | --- |
| **Player report** | Report attaches `match_id` + reported `account_id` + tag (aimbot/wallhack/speed). Queued to Anti-Cheat. |
| **Auto-flag** | High risk score or validator hits auto-queue the match. |
| **Appeal** | Analyst pulls the replay as primary evidence (§4.4). |

An analyst (or automated pass) can:

- Re-run detectors over the **server-truth** stream (not client claims).
- Watch a rendered replay from any camera, including the suspect's.
- Correlate suspect actions with the **relevancy timeline** — e.g. did they
  pre-aim an enemy the server never made relevant to them? That's near-conclusive
  wallhack evidence, and it's derived entirely from server data.

### 7.3 Why this is trustworthy

The replay is built from what the **server** observed and decided, not from a
client-uploaded recording (which a cheater could forge). It's the same data the
authoritative sim used, so it can't be tampered with post-hoc without detection.

---

## 8. Consolidated Threat Model

Legend for **Where enforced**: `C` = client (low trust, signal only),
`MS` = match server (authoritative sim), `BE` = backend microservices,
`EDGE` = gateway/transport, `AC` = anti-cheat pipeline, `PSP` = payment provider.

| # | Threat | Primary mitigation | Where enforced |
| --- | --- | --- | --- |
| 1 | Forged/altered movement (speed, teleport, fly, noclip) | Server-simulated movement; velocity/collision clamping; reject impossible deltas | MS (+AC scoring) |
| 2 | Fake hit / instakill / "I killed them" | Server does hit resolution & damage; lag-comp within bounded window | MS |
| 3 | God mode / infinite health | Server owns HP & state transitions | MS |
| 4 | Infinite ammo / rapid fire / no recoil | Server enforces fire-rate, mag, reload, recoil seed; reject violations | MS |
| 5 | Aimbot / triggerbot / impossible accuracy | Statistical anomaly detection (accuracy, snap kinematics, reaction) + replay review | AC (+MS fire validation) |
| 6 | Wallhack / ESP (visual) | Server-side relevancy: don't replicate non-perceivable entities | MS |
| 7 | Sound ESP | Audio as low-precision gameplay events, not transforms | MS |
| 8 | Item duplication / remote loot / illegal pickup | Server validates existence, proximity, ownership, capacity | MS (+BE ledger) |
| 9 | Currency/XP inflation ("I earned N") | Rewards come only from signed match results / verified purchases; ledger is single-writer | BE |
| 10 | IAP receipt forgery / local billing patch | Server-side receipt verification with Apple/Google before grant | BE (+PSP) |
| 11 | Stolen card / chargeback fraud | PSP risk + velocity rules + 3DS/SCA; auto-suspend on chargeback | PSP + BE |
| 12 | Token theft / replay | Short-lived JWTs; refresh rotation + reuse-detection family revocation; jti denylist | BE + EDGE |
| 13 | `alg`/key confusion, forged JWT | Pinned EdDSA + JWKS `kid` allow-list; reject `none`/RSA/HMAC confusion | BE |
| 14 | Account takeover | 2FA/passkeys, step-up on risky ops, device binding, re-auth on link | BE |
| 15 | Admin privilege abuse / lateral movement | Separate admin keys+audience, server-side RBAC, 2FA, dual-control, audit log, IP-allowlist | BE |
| 16 | Credential stuffing / brute force | Rate limits + lockout + backoff; breach-password checks; CAPTCHA/step-up on risk | EDGE + BE |
| 17 | MITM / packet inspection & crafting | TLS 1.3 + cert pinning; DTLS 1.3 for realtime; AEAD-authenticated packets | EDGE |
| 18 | Packet replay / injection | Per-match keys, sequence numbers, sliding-window replay filter, AEAD | MS + EDGE |
| 19 | DDoS / UDP amplification | Edge scrubbing, connection-cookie handshake, rate limits, autoscale | EDGE |
| 20 | Injection (SQLi/XSS/IDOR) | Parameterized queries, DTO validation, per-object authz, CSP/output encoding | BE |
| 21 | Ban evasion (new account/device/IP) | Association graph, device attestation continuity, new-account trust tier, cluster/shadow bans | BE + AC |
| 22 | Modified/tampered client binary | Checksum/anti-tamper + platform attestation (risk signal); server-authority makes payoff low | C (signal) → AC/BE |
| 23 | Rooted/jailbroken device, hooking tools (Frida/GameGuardian) | Detection as risk signal; **assume bypassable**; rely on server truth | C (signal) → AC |
| 24 | Fake lag / lag switching | Bounded lag-comp window; reject out-of-window timestamps; score latency manipulation | MS + AC |
| 25 | RMT / account selling / boosting | Trade-graph detection, session concurrency limits, region/device anomalies | BE + AC |
| 26 | Forged match report / replay tampering | Replays built from server-observed truth, not client uploads | MS + BE |
| 27 | False-positive ban (skilled player mis-flagged) | Confidence thresholds, human + replay review, appeal flow, FP-rate metric | AC + human |

---

## 9. Honest summary of limits

We are candid with ourselves about where the walls are:

- **Server-authority is strong and structural** — it eliminates whole cheat
  classes and is the foundation everything else rests on.
- **Relevancy-based ESP defense is the best available** and removes the data most
  wallhacks need — but a smoothness margin will always leak a little, so we pair
  it with detection.
- **Aimbot detection is probabilistic**, not certain; humanized cheats approach
  the human distribution. Volume of samples + cross-signal correlation + replay
  review keep it effective without over-banning skilled players.
- **Mobile client-side anti-cheat is imperfect by construction.** It runs on the
  attacker's hardware. We use it for risk signal and cost, lean on platform
  attestation as the strongest client signal, and never make it the point of
  failure.
- **Ban evasion cannot be made impossible**, only expensive, short-lived, and
  re-detectable via behavior.
- **The winning strategy is the system, not any one control:** authoritative
  simulation + statistical detection + attestation + association graph + fast
  enforcement + due-process appeals, tuned continuously against real cheat
  telemetry.

---

*Related docs:* `03-auth-service.md` (implementation), `06-economy-battlepass.md`
(ledger detail), `07-matchmaking-dedicated-servers.md` (match server contract),
`09-liveops-devops.md` (monitoring, incident response).
