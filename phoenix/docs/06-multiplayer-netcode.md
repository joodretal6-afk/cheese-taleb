# 06 — Multiplayer Netcode

> **Subsystem:** In-match networking, dedicated server, and the server ↔ backend session contract.
> **Engine:** Unreal Engine 5.6 dedicated server (Linux, headless). **Backend:** NestJS microservices.
> **Scale target:** 100 players / match, one large open map (~8 km × 8 km), 60–75 concurrent matches per server node.
> **Audience:** Multiplayer engineers, backend engineers owning Matchmaking/Session, DevOps owning the Agones fleet.

This document is the authoritative design for how Project Phoenix moves state between clients and the
authoritative server, how a match is spun up and torn down, and the exact contract the UE5 dedicated
server speaks to the backend. It is deliberately concrete: numbers here are the budgets we build and
profile against, not aspirations.

---

## 0. Design principles (non-negotiable)

1. **The server is the single source of truth.** The client never tells the server "I hit X" or "I am
   at position Y and it is final." The client sends *intent* (input); the server simulates and sends
   *results*. Everything a cheater could forge is recomputed or validated server-side.
2. **Mobile is the constraint, not the desktop.** Every budget below is set by a mid-tier 5-year-old
   Android phone on a congested LTE link, not by a flagship on Wi-Fi.
3. **Predict locally, reconcile authoritatively.** The local player feels zero input latency; every
   correction is smoothed, never a visible snap where avoidable.
4. **Bandwidth is spent where the player is looking.** Relevancy and interest management mean a player
   pays bandwidth for the ~15–30 players who can affect them, not for all 99 others.
5. **Determinism where it buys us cheat-resistance and debuggability**, but we do **not** run a
   fully-deterministic lockstep simulation (wrong model for 100-player BR on mobile). We run
   server-authoritative simulation with client prediction.

---

## 1. Netcode model overview

### 1.1 Topology

```
                       ┌─────────────────────────────────────────┐
                       │        Backend (NestJS, K8s)             │
                       │  Matchmaking · Session · Ranking ·       │
                       │  Stats · Inventory · Auth                │
                       └───────────────┬─────────────────────────┘
                                       │ gRPC (session contract, §7)
                                       │
   ┌──────────────┐   allocate    ┌────▼───────────────┐
   │  Agones      │◄──────────────│ Matchmaking svc    │
   │  Fleet (K8s) │  GameServer   └────────────────────┘
   └──────┬───────┘  allocated
          │ Ready → Allocated
   ┌──────▼─────────────────────────────┐
   │  UE5 Dedicated Server (pod)         │   authoritative sim @ 30 Hz
   │  ┌────────────┐  ┌───────────────┐  │
   │  │ ReplGraph  │  │ Lag-comp ring │  │
   │  └────────────┘  └───────────────┘  │
   └───▲───▲───▲──────────────────▲──────┘
       │   │   │  UDP (UE NetDriver, encrypted)
       │   │   │                  │
   ┌───┴┐ ┌┴──┐ ┌┴──┐          ┌──┴──┐
   │ P1 │ │P2 │ │P3 │  …  ×100 │P100 │   clients: predict + interpolate
   └────┘ └───┘ └───┘          └─────┘
```

- **Transport:** UDP via UE's NetDriver. We ship the engine's Iris replication system (UE5.6) for the
  replication core, with our own **replication graph spatialization layer** for relevancy. (Iris and
  the classic replication graph are both viable in 5.6; Phoenix standardizes on **Iris + custom
  filtering** — see §1.3. Fallback path to classic `UReplicationGraph` is kept behind a cvar for
  platforms where Iris is disabled.)
- **No peer-to-peer, ever.** All game traffic flows client ↔ dedicated server. Clients never learn each
  other's IPs (privacy + anti-cheat + DDoS surface).
- **Encryption:** DTLS-style handshake on connect; packets encrypted with a per-session key handed to
  the client by the Session service (§7.3). This stops trivial packet crafting and replay.

### 1.2 Authoritative simulation loop

The server runs a fixed-timestep authoritative simulation:

| Parameter | Value | Notes |
| --- | --- | --- |
| Server sim tick | **30 Hz** (33.3 ms) | Physics + gameplay. Weapon traces resolved here. |
| Server send rate (per client) | **20 Hz** adaptive (10–30 Hz) | Throttled per-client by congestion + relevancy budget. |
| Client input send rate | **30–60 Hz** | Matches client frame rate up to 60; coalesced if frame > send. |
| Client render rate | 30/60/90/120 fps | Decoupled from netrate; interpolation fills the gap. |

The server never trusts wall-clock from the client; it stamps every input with the server tick it was
applied on and drives reconciliation from that.

### 1.3 Relevancy / interest management for 100 players

Replicating all 100 actors to all 100 clients is O(N²) and instantly blows the mobile bandwidth budget.
We cut it down with layered filtering, evaluated every relevancy update (~5–10 Hz, not every tick):

**Layer A — Spatial grid (the big win).**
The map is divided into a uniform grid of **200 m × 200 m cells**. Every replicated actor registers into
its current cell. A player receives full-fidelity updates only for actors within their **relevancy
radius** (below), resolved by cheap cell lookups instead of per-actor distance checks.

| Actor class | Relevancy radius | Rationale |
| --- | --- | --- |
| Other players (on-foot) | **300 m** | Beyond this, invisible on mobile screen; only shows on minimap via low-rate blips. |
| Players in vehicles | **450 m** | Vehicles are seen/heard further; audio + dust. |
| Projectiles / thrown | **250 m** | Short-lived; only matters near you. |
| Loot / world items | **120 m** | Only relevant when you can walk to it. |
| Vehicles (empty) | **400 m** | Sightlines. |
| Air/parachute phase | **1500 m** | Everyone falling from the plane needs coarse awareness; low-rate. |

**Layer B — Frustum / occlusion hinting (soft).**
Not hard occlusion (server can't trust client camera), but we bias update *rate* toward actors in the
client's reported view cone. An enemy directly ahead updates at full rate; one behind you (still in
radius) updates slower until they re-enter relevance. This is a *rate* optimization only — never a
visibility gate that could be abused to hide wall-hacks, because the loot/enemy is still replicated when
in radius.

**Layer C — Dormancy.**
Static and idle actors (unlooted crates, parked vehicles, doors) go **dormant** and stop consuming
per-tick replication cost until touched. Waking is event-driven.

**Layer D — Priority + starvation guard.**
Each relevant actor gets a dynamic priority: `base_class_priority × recency × proximity × threat`.
Threat spikes for actors shooting near you or on your screen. A **starvation counter** guarantees even
low-priority relevant actors get an update at least every N ticks so nothing goes stale.

**Net effect:** a typical mid-game player has **15–30 relevant players** + a few dozen items, not 99+.
Early "plane" phase and final-circle crunch (many players in a tiny gas circle) are the two worst cases;
§4.4 covers how we hold the budget there.

---

## 2. Movement: prediction & reconciliation

We use UE's `CharacterMovementComponent` (CMC) model, hardened and tuned for BR + mobile. CMC already
implements client prediction and server reconciliation; the work is making it robust at 100 players and
validating it for anti-cheat.

### 2.1 The loop

```
CLIENT                                         SERVER
──────                                         ──────
frame t: sample input (move, look, jump,
         crouch, fire-intent)
  │ build FSavedMove, assign ClientTimestamp
  │ APPLY locally  ── predicted position ──►   (local player already moving, 0 latency felt)
  │ send input+move to server ───────────────► receive move for input @ ClientTimestamp
  │                                            validate (speed/accel/teleport → §8)
  │                                            simulate authoritatively on CMC
  │                                            record authoritative state + last-acked
  │◄──────── ServerMoveResponse (ack + pos) ── send correction ONLY if divergence > threshold
  │
  │ if ack matches prediction → discard saved move (no visible change)
  │ if mismatch → REPLAY: snap to server pos at that tick,
  │              re-apply all unacked saved moves on top,
  │              SMOOTH the visual delta over ~100–150 ms
```

### 2.2 Key details

- **Client keeps an ordered queue of unacknowledged `FSavedMove`s.** On correction, it rewinds to the
  server-authoritative state for the acked move and *replays* every newer input. The player's local
  avatar therefore ends up in the corrected-but-consistent place, not thrown back in time.
- **Correction threshold.** We only send a correction if positional error > **~5 cm** or rotation/state
  diverges. Below that, the server silently accepts the client's predicted position (within validated
  bounds) to avoid correction spam. This tolerance is *tighter* than default UE because loose thresholds
  are a speed-hack vector.
- **Visual smoothing.** Corrections are never hard snaps for the local player except on teleport/large
  desync; the mesh interpolates to the corrected capsule over 100–150 ms (`NetworkSmoothingMode =
  Exponential`).
- **Remote players are interpolated, not predicted.** For everyone else you see, the client buffers
  ~100 ms of received snapshots and renders **interpolated** in the past. This is what makes lag comp
  (below) both necessary and correct.

### 2.3 Interpolation / buffering budget

| Buffer | Value | Purpose |
| --- | --- | --- |
| Remote-actor interpolation delay | **100 ms** (3 server sends @ 20 Hz) | Smooth remote motion despite jitter. |
| Jitter buffer (adaptive) | 1–4 packets | Grows on unstable links, shrinks on clean ones. |
| Input redundancy | last **3** inputs per packet | Survive single/double packet loss without a stall. |

---

## 3. Hit registration: lag compensation & server-side shooting

### 3.1 The problem

Player A sees Player B rendered ~100 ms in the past (interpolation delay) plus their own network latency.
When A fires "at B's head," B on the server has already moved. If the server checked the trace against
B's *current* position, well-aimed shots would miss. So we **rewind**.

### 3.2 Server-side rewind (lag compensation)

The server keeps a **history ring buffer** of hitbox/bone transforms for every player, ~**1 second** deep
at snapshot resolution:

```
Player B hitbox history (server), newest → oldest
[ t0 ][ t-33 ][ t-66 ][ t-100 ][ t-133 ] … up to ~1000 ms
   each entry = capsule + per-bone OBBs (head, torso, limbs) + timestamp(serverTick)
```

**Shot resolution algorithm (runs entirely on server):**

1. Client sends a **fire command**: `{ weaponId, muzzleOrigin, aimDir, clientFireTime, clientTick, seq }`.
   It does **not** send "I hit player B." Origin/dir are validated against the server's own view of the
   shooter's camera/weapon (must be within tolerance of where the server thinks the muzzle is).
2. Server computes the shooter's **effective rewind time**:
   `rewindTime = now − (shooterRTT/2 + shooterInterpolationDelay)`, clamped to the history depth
   (max ~1000 ms; anything older is rejected as implausible).
3. Server **rewinds every candidate target's hitboxes** to `rewindTime` by interpolating between the two
   nearest ring-buffer snapshots.
4. Server runs the **authoritative trace** (hitscan) or spawns the **server-authoritative projectile**
   from the validated muzzle transform against the rewound hitboxes.
5. On hit: server applies damage with the correct hitbox multiplier (head/torso/limb), consumes ammo,
   applies recoil state, and replicates the damage/kill events. Clients get a confirmed hitmarker from
   the server, not from local prediction.

```
              client fires
                  │  clientFireTime, seq
                  ▼
   ┌──────────────────────────────────────┐
   │ SERVER                                │
   │  1. validate muzzle origin/dir vs     │
   │     server-known shooter transform    │
   │  2. rewindTime = now − (RTT/2 + interp)│
   │  3. rewind targets' hitboxes          │
   │  4. authoritative trace / projectile  │
   │  5. apply damage, ammo, recoil        │
   │  6. replicate hit/kill events         │
   └──────────────────────────────────────┘
```

### 3.3 Weapon types

- **Hitscan (SMG, AR at close/mid, pistols):** instant server trace against rewound hitboxes.
- **Projectile (sniper rounds, thrown, launchers):** **server-authoritative projectile** with travel
  time and drop. Client spawns a *cosmetic* predicted tracer immediately for feel; the real projectile
  lives on the server and its impact is authoritative. Lag comp still rewinds targets for the moment the
  projectile crosses them.
- **Spread/recoil:** the RNG **seed is server-owned** and deterministic per shot sequence number. The
  client predicts spread using the same seed algorithm for visual feedback, but the server's computed
  spread is authoritative. This closes the "no-spread" cheat.

### 3.4 Fairness bounds

Lag comp favors the shooter, which can produce the "shot behind cover" feeling for the victim. We bound
this:

- **Max rewind = ~200–250 ms of *usable* compensation** for gameplay (history is 1 s but we reject
  compensation beyond a fairness cap). Above the cap, the shot is resolved at the cap, so a 900 ms-latency
  player cannot rewind you most of a second into the past.
- **"Behind full cover" grace:** if the rewound target is, at *present* server time, fully behind static
  geometry, we can optionally reject the hit (tunable per weapon). Default: allow within cap.
- All rewind decisions are logged (§8.4) for anti-cheat correlation.

---

## 4. Bandwidth, tick budget & replication economics (mobile)

### 4.1 Targets

These are the numbers we profile every build against on the reference mid-tier device + throttled LTE.

| Metric | Target (steady mid-game) | Hard ceiling | Notes |
| --- | --- | --- | --- |
| Downstream to client | **~30–50 KB/s** | 80 KB/s | Bursts allowed in final circle. |
| Upstream from client | **~8–15 KB/s** | 25 KB/s | Inputs + fire commands. |
| Server send rate / client | 20 Hz | 30 Hz | Adaptive down to 10 Hz under congestion. |
| Server sim tick | 30 Hz | — | Fixed. |
| Per-packet size (MTU-safe) | ≤ **1200 B** | 1200 B | Below common mobile MTU to dodge fragmentation. |
| Added client input latency (predicted local) | **0 ms felt** | — | Prediction hides it. |
| Playable RTT range | 20–150 ms good; up to 250 ms tolerable | 350 ms → reconnect nudge | Above this, quality warning shown. |

### 4.2 What keeps us inside the budget

1. **Relevancy (§1.3)** — the biggest lever. You pay for ~20 players, not 99.
2. **Delta compression.** UE replicates only **changed properties** since the client's last acked state.
   A standing-still enemy costs almost nothing.
3. **Quantization.** Positions quantized to the map's needed precision (cm-scale, not full float),
   rotations to compressed byte-angles, velocities to compact forms. Full float replication is banned for
   transforms.
4. **Property-level send-rate tiers.** Not every property replicates at 20 Hz:

   | Property tier | Rate | Examples |
   | --- | --- | --- |
   | Hot | 20 Hz | Position, rotation, velocity of relevant players near you. |
   | Warm | 5–10 Hz | Health, ammo, state flags. |
   | Cold | On-change only | Loadout, cosmetics, name, team. |
   | Minimap/blips | 1–2 Hz | Coarse positions of non-relevant players (audio/spot events). |

5. **Adaptive throttle.** A per-client congestion controller watches ack RTT + loss and drops send rate
   (20→10 Hz) and relevancy radius before it drops correctness. Degrade gracefully, never desync.
6. **Voice/audio on a separate lane** (Opus, low bitrate, jitter-buffered), never on the gameplay channel.

### 4.3 The shrinking safe-zone (gas / storm)

The play-zone shrink is a **low-cost, high-consistency** replication problem, and it must be *identical*
on every client (it kills you), so we do **not** stream it as continuous geometry.

**Representation.** The zone is a parametric object, not a mesh:

```
struct FZoneState {
  uint8   phaseIndex;        // which shrink phase (0..N)
  FVector2D  currentCenter;  // quantized
  FVector2D  nextCenter;     // quantized (already decided, revealed on schedule)
  float   currentRadius;     // quantized
  float   nextRadius;
  double  phaseStartServerTime;
  double  phaseEndServerTime; // clients LERP center/radius over this window
  uint8   damagePerTick;     // gas DPS bracket for this phase
}
```

- Replicated as a **single small struct on-change** (a few phase transitions per match), not per-tick.
  Between phases, **clients interpolate** center/radius locally from `phaseStart/End` server times — zero
  ongoing bandwidth for the animation.
- **`nextCenter`/`nextRadius` are decided server-side up front** and revealed on the schedule, so the
  circle indicator draws identically everywhere.
- **Gas damage is applied server-side.** The client draws the ring and predicts "I'm taking gas damage"
  for UI feel, but the actual damage ticks are authoritative (anti-cheat: no "ignore the gas" client
  patch works).
- Total zone cost across a whole match: **kilobytes**, not a stream.

### 4.4 Worst-case phases

- **Plane / free-fall (t=0):** 100 players spatially clustered. We use the **1500 m coarse air relevancy**
  at a **very low rate (2–3 Hz)** and heavy quantization — everyone's a low-fidelity blip until they land.
- **Final circle (10 players in 50 m):** everyone is relevant to everyone → near O(N²), but N is now
  ≤ ~10, so full 20–30 Hz fidelity is affordable. The budget curve is deliberately shaped: cheap when
  crowded-and-far, affordable when crowded-and-near.

---

## 5. Match lifecycle (end to end)

### 5.1 Sequence

```
 ┌────────┐   1. enqueue        ┌──────────────┐
 │ Client │ ──────────────────► │ Matchmaking  │
 └────────┘  (mode, region,     │  service     │
             party, MMR)        └──────┬───────┘
                                       │ 2. forms a 100-player lobby (MMR + region + latency buckets)
                                       │
                                       │ 3. RequestAllocation ──► ┌──────────┐
                                       │                          │ Agones   │ 4. Allocate a Ready
                                       │◄── GameServer (ip:port,  │ Allocator│    GameServer from Fleet
                                       │      allocationId) ──────└────┬─────┘
                                       │                               │ 5. Agones sets GS → Allocated
                                       │ 6. CreateSession(sessionId,   │
                                       │    roster[], mapId, seed,     ▼
                                       │    zoneSchedule) ────────► ┌───────────────┐
                                       │                            │ UE5 Dedicated │ 7. loads map, seeds
                                       │◄── SessionReady ───────────│ Server (pod)  │    RNG, opens NetDriver
                                       │                            └──────┬────────┘
   8. Matchmaking pushes each client:  │                                   │
   { serverIp, port, sessionToken } ───┘                                   │
        │                                                                  │
        └──── 9. client connects (UDP + sessionToken) ────────────────────►│ validates token vs roster
                                                                           │ 10. IN-MATCH sim
                                                                           │
                                                                           │ 11. periodic MatchHeartbeat →
                                                                           │     Session (alive, playerCount)
                                                                           │
                                                                           │ 12. on kills/round events →
                                                                           │     buffered event stream
                                                                           ▼
                                       ┌───────────────┐  13. MatchResult (final placement,   │
                                       │ Ranking /     │◄─── kills, damage, survival time,     │
                                       │ Stats /       │     loot, per-player deltas) ─────────┘
                                       │ Inventory     │
                                       └───────────────┘  14. backend updates MMR, XP,
                                                              battle-pass, inventory grants
                                       ┌──────────────┐
                                       │ Agones       │  15. GS calls Shutdown → pod recycled,
                                       │ Fleet        │◄─── Fleet spins a fresh Ready replica
                                       └──────────────┘
```

### 5.2 Phase table

| Phase | Owner | What happens | Failure handling |
| --- | --- | --- | --- |
| Queue | Matchmaking | Player enqueues with mode/region/party/MMR. | Timeout → widen MMR band, then region. |
| Lobby formed | Matchmaking | 100 players bucketed by MMR + ping. | Under-fill → backfill or relax; below floor → cancel, re-queue. |
| Allocation | Matchmaking → Agones | `Allocate()` pulls a **Ready** GS. | No capacity → Fleet autoscaler + retry; final fallback: alternate region. |
| Session create | Matchmaking → GS (gRPC) | Roster, map, seed, zone schedule pushed. | GS NACK/timeout → deallocate, re-allocate elsewhere. |
| Connect | Clients → GS (UDP) | Token-validated join; 60 s join window. | No-show → bot/AFK handling per mode; slot stays reserved briefly. |
| In-match | GS authoritative | Simulation, events streamed. | GS crash → §6.3 salvage/abort. |
| Results | GS → backend (gRPC) | `MatchResult` reported once, idempotently. | Retry with idempotency key until acked. |
| Teardown | GS → Agones | `Shutdown()`; pod recycled. | Agones health-check reaps stuck pods. |

### 5.3 Dedicated server allocation (Agones / Fleet on K8s)

- **Fleet:** a K8s-managed pool of pre-warmed UE5 dedicated-server pods per region, each in `Ready` state
  with the map preloaded (warm start ≈ sub-second to accept a session vs. cold pod launch).
- **FleetAutoscaler:** buffer-based — keep *N* Ready replicas as headroom above current allocation rate;
  scale the underlying node pool via cluster autoscaler when the buffer can't be met.
- **Allocation:** Matchmaking calls the **Agones Allocator Service** (gRPC), which atomically moves one
  `Ready` GS → `Allocated` and returns its routable `ip:port` + `allocationId`. Allocation is the
  synchronization point — two lobbies can never grab the same server.
- **One match per pod** (BR model): the pod serves exactly one 100-player match, then `Shutdown()`s and is
  replaced by a fresh Ready replica. This gives clean state isolation and trivial crash blast-radius.
- **Health:** the GS SDK sends `Health()` pings to the Agones sidecar; a GS that stops pinging is marked
  Unhealthy and reaped.
- **Networking:** each pod exposes a UDP game port via `hostPort`/GameServer port policy; a regional
  L4 load balancer / node public IP fronts it. Clients connect directly to `ip:port` (no proxy in the
  hot path — proxies add latency).

---

## 6. Reconnect, region selection, ping

### 6.1 Region selection & ping optimization

- On login the client **pings all regional edges** (a lightweight UDP ping endpoint per region) and ranks
  by median RTT + jitter + loss. Result feeds matchmaking as `preferredRegions[]` (ordered).
- Matchmaking prefers the player's best region but may place a party in a **shared best region** so party
  members aren't split; it never places a player into a region above their latency ceiling without consent.
- **Ping optimizations:**
  - MTU-safe packets (≤1200 B) to avoid fragmentation retransmits.
  - Anycast / edge PoPs so the first hop to our network is short; game traffic then rides our backbone.
  - Adaptive jitter buffer + input redundancy (§2.3) turn jitter into smoothness rather than corrections.
  - Congestion-aware send-rate throttle (§4.2) protects correctness on bad links.
- **Ping/quality HUD:** client shows RTT, loss, and a quality bar; crosses to a warning state >250 ms or
  >5% loss.

### 6.2 Reconnect flow

A match can be 20+ minutes; a mobile player *will* drop (tunnel, call, app backgrounded). We must let them
back in with their exact state.

```
 client detects timeout (no server acks for ~5 s)
        │  show "Reconnecting…" overlay, keep session token
        ▼
 attempt UDP reconnect to SAME serverIp:port with { sessionToken, playerId, lastAckedTick }
        │
   ┌────┴─────────────────────────────────────────────┐
   │ SERVER: is this player still ALIVE and within the │
   │ reconnect grace window (default 120 s)?           │
   └────┬───────────────────────────┬──────────────────┘
     yes│                        no │ (dead OR window expired)
        ▼                           ▼
 re-attach to existing pawn,    reject → client returns to
 fast-forward: send full        lobby; match result already
 snapshot of relevant state,    or eventually reported for them
 resume prediction
```

- **Grace window:** while disconnected-but-alive, the player's pawn stays in the world (vulnerable — you
  can be killed while reconnecting; this is intended for BR fairness) for up to **120 s**. After that, or
  on death, the pawn is removed and reconnect is refused.
- **App backgrounding (mobile-specific):** iOS/Android suspend the socket. On resume within grace, we run
  the same reconnect path. Beyond grace, it's a normal disconnect.
- **Session token** is what authorizes re-entry — it's bound to `{sessionId, playerId}` and validated
  against the still-loaded roster on the GS, so a dropped player rejoins *their* slot and no one else's.
- **State resync:** on re-attach the server sends a **full (non-delta) snapshot** of all currently-relevant
  actors + the player's own authoritative state + current `FZoneState`, then resumes normal delta
  replication. The client discards its stale prediction queue and rebuilds from the snapshot.

---

## 7. GS ↔ Backend contract (Matchmaking / Session)

This is the interface backend engineers and multiplayer engineers must agree on. It is versioned and
lives in `packages/` as shared protobuf so both sides compile against one source of truth.

### 7.1 Protocol choice

| Link | Protocol | Why |
| --- | --- | --- |
| Matchmaking → Agones Allocator | **gRPC** | Agones' native allocation API. |
| Matchmaking/Session ↔ GS (control plane) | **gRPC** (server-streaming for heartbeat/events) | Typed, versioned, HTTP/2 multiplexed, mutual-TLS inside the cluster. |
| GS → Ranking/Stats/Inventory (results) | **gRPC** call, or publish to **Kafka** `match.results` topic | Kafka gives durable, replayable, idempotent fan-out to multiple consumers (Ranking, Stats, Inventory, analytics). Preferred for results. |
| Client ↔ GS | **UDP** (UE NetDriver, encrypted) | Real-time game traffic. Not part of this contract. |
| Client ↔ Matchmaking | **WebSocket / REST** | Queue, status, receive `{serverIp, port, sessionToken}`. |

All control-plane gRPC is **mutual-TLS**; the GS authenticates to the backend with a pod-issued service
identity (K8s ServiceAccount token / SPIFFE), and the backend authenticates to the GS with the
allocation-scoped credential. The GS never trusts an unauthenticated caller for `CreateSession`.

### 7.2 Message catalog (protobuf, abridged)

```proto
// ---- Backend → GS: create the match ----
message CreateSessionRequest {
  string session_id      = 1;   // backend-owned UUID, correlates everything
  string allocation_id   = 2;   // from Agones, ties to this pod
  string map_id          = 3;
  uint64 world_seed      = 4;   // deterministic loot/zone seed (server-owned)
  ZoneSchedule zone      = 5;   // precomputed shrink phases (centers/radii/timings)
  MatchMode  mode        = 6;   // SOLO / DUO / SQUAD
  repeated RosterEntry roster = 7;  // 100 authorized players
  uint32 join_window_sec = 8;   // default 60
  string result_sink     = 9;   // kafka topic or grpc target for MatchResult
}
message RosterEntry {
  string player_id       = 1;
  string session_token   = 2;   // client must present this over UDP to join
  string party_id        = 3;   // squad grouping
  uint32 team_slot       = 4;
  LoadoutRef loadout     = 5;   // cosmetic/loadout refs resolved from Inventory
  int32  mmr             = 6;
}
message CreateSessionResponse {
  bool   accepted        = 1;
  string reason          = 2;   // set when accepted=false
  string gs_build_ver    = 3;   // for compat gating
}

// ---- GS → Backend: liveness + progress (server-streamed) ----
message MatchHeartbeat {
  string session_id      = 1;
  MatchPhase phase       = 2;   // LOBBY / IN_PROGRESS / ENDING
  uint32 players_alive   = 3;
  uint32 players_connected = 4;
  uint32 zone_phase      = 5;
  double server_time     = 6;
  float  tick_health     = 7;   // measured sim Hz; alert if < 28
}

// ---- GS → Backend: live gameplay events (optional stream, for spectate/analytics/anti-cheat) ----
message MatchEvent {
  string session_id      = 1;
  oneof event {
    KillEvent      kill      = 10;
    DamageEvent    damage    = 11;
    ReviveEvent    revive    = 12;
    PickupEvent    pickup    = 13;
    AnomalyEvent   anomaly   = 14;  // anti-cheat: validated-server-side flag (§8)
  }
  uint64 server_tick     = 20;
}

// ---- GS → Backend: authoritative final result (idempotent) ----
message MatchResult {
  string session_id      = 1;
  string idempotency_key = 2;   // = session_id; safe to retry
  double match_duration_s = 3;
  repeated PlayerResult players = 4;
  string map_id          = 5;
  MatchMode mode         = 6;
}
message PlayerResult {
  string player_id       = 1;
  uint32 placement       = 2;   // 1 = winner
  uint32 kills           = 3;
  uint32 assists         = 4;
  float  damage_dealt    = 5;
  float  survival_time_s = 6;
  uint32 revives         = 7;
  bool   disconnected    = 8;   // left before elimination
  repeated ItemGrantRef loot = 9;   // items to reconcile with Inventory
  int32  mmr_before      = 10;  // GS echoes; backend recomputes mmr_after
}
```

### 7.3 Client join credential (`sessionToken`)

- Minted by Session service, embedded in each `RosterEntry`, and also delivered to the client by
  Matchmaking. It is a short-lived signed token bound to `{sessionId, playerId, gsAllocationId}`.
- On UDP connect the client presents it; the GS validates it against the roster it received in
  `CreateSessionRequest` (no round-trip to backend needed in the hot path). Mismatch → connection refused.
- Doubles as the **reconnect** credential (§6.2) and carries the **per-session encryption key** material.

### 7.4 Idempotency & durability

- `MatchResult.idempotency_key == session_id`. Backend consumers **dedupe on it**, so the GS can retry
  reporting after a transient failure without double-crediting XP/MMR/loot.
- Results go to Kafka `match.results`; Ranking, Stats, and Inventory are independent consumers. If
  Inventory is down, it processes the grant later from the log — no loss.
- The GS considers a match "reported" only after Kafka ack (or gRPC 2xx); until then it keeps retrying and
  will not `Shutdown()`.

### 7.5 State machine (backend's view of a session)

```
 REQUESTED ──alloc ok──► ALLOCATED ──CreateSession ack──► READY
     │                        │                              │ clients connecting
     │ alloc fail             │ NACK/timeout                 ▼
     ▼                        ▼                          IN_PROGRESS
  RE-ALLOCATE ◄───────────────┘                              │ heartbeats
                                                             ▼
                                                          ENDING ──MatchResult acked──► CLOSED
                                                             │                             │
                                                             │ GS crash / no heartbeat     │ Shutdown()
                                                             ▼                             ▼
                                                          SALVAGE (§6.3) ──────────────► REAPED
```

### 7.6 Crash / salvage (referenced by §5.2, §7.5)

- **Missing heartbeats** (> ~15 s): Session marks the GS suspect. If it never returns, the match is
  declared **aborted**: surviving players get a "server lost" result (no MMR loss, partial stats credited
  from the last `MatchEvent` stream), and the pod is reaped by Agones health checks.
- **Partial results:** because kills/damage stream live as `MatchEvent`s, an aborted match can still credit
  what actually happened up to the crash, rather than voiding everything.

---

## 8. Anti-cheat touchpoints inside netcode

Netcode owns the **server-side validation** layer of anti-cheat. Client-side integrity (attestation,
tamper detection, the anti-cheat SDK) lives in the security module (doc 09); here we cover only what the
authoritative server checks because *it already has the ground truth*.

Guiding rule: **if the server can recompute it, the server does not trust the client's version of it.**

### 8.1 Movement validation (speed / position / teleport)

Every `ServerMove` is checked before it's accepted:

| Check | Rule | Action on violation |
| --- | --- | --- |
| **Max speed** | `distance / dt ≤ maxSpeed(state) × tolerance(1.1)` given current movement mode (walk/sprint/vehicle/parachute) and buffs. | Reject move, snap to last valid, increment suspicion. |
| **Acceleration / impulse** | Velocity change per tick within physical bounds. | Reject + flag. |
| **Teleport** | Position delta over one tick exceeds max-possible-for-dt (accounting for legit teleporters if any). | Reject, hard-correct, flag `AnomalyEvent`. |
| **Vertical / fly** | Z-movement not explained by jump/fall/vehicle/zipline/parachute. | Reject + flag (no-clip / fly hack). |
| **Ground clip / no-clip** | Server collision says the requested position is inside geometry. | Reject to last valid ground position. |
| **Time dilation / speedhack** | Aggregate client input timestamps vs. server clock drift beyond tolerance. | Throttle to server clock; flag. |

Because movement is server-simulated (CMC) and we keep the correction threshold tight (§2.2), a speed or
teleport hack manifests as *constant rejections/corrections*, which both neutralizes the cheat and creates
a strong signal.

### 8.2 Fire-rate & weapon validation

| Check | Rule |
| --- | --- |
| **Rate of fire** | Server enforces `minInterval = 60/RPM` per weapon; shots arriving faster are dropped. Kills the auto-fire/rapid-fire macro. |
| **Ammo** | Server owns the magazine; a fire command with no server-side ammo is rejected. No client "infinite ammo." |
| **Reload timing** | Fire during a server-tracked reload → rejected. |
| **Muzzle origin/direction** | Fire command's origin/dir must be within tolerance of where the server thinks the shooter's camera/muzzle is (§3.2 step 1). Rejects "shoot from arbitrary coordinates" / silent-aim origin spoofing. |
| **Spread/recoil seed** | Server-owned deterministic seed (§3.3); client cannot report "no spread." |
| **Rewind sanity** | Requested compensation clamped to fairness cap (§3.4); implausibly old fire times rejected. |
| **Line of fire** | Authoritative trace runs against real server geometry, so shooting through walls fails server-side even if a client hack "sees" through them. |

### 8.3 Damage & state validation

- **Damage is never client-reported.** The server computes damage from its authoritative trace, weapon
  table, distance falloff, and hitbox multiplier. A client claiming a kill is ignored.
- **Health/shield are server-owned**; god-mode client patches don't change the server's number.
- **Gas/zone damage** applied server-side (§4.3) — "ignore the gas" hacks do nothing.
- **Pickups/loot** validated by proximity + server inventory; you can't grant yourself items.

### 8.4 Telemetry → anti-cheat pipeline

- Rejections and anomalies emit `AnomalyEvent` on the `MatchEvent` stream with context (player, tick,
  check, magnitude). These flow to the anti-cheat/analytics backend (doc 09) via Kafka.
- A single rejection is noise (lag causes some); the backend correlates **rates and patterns** across a
  match and across a player's history to decide on shadow-flag / kick / ban. Netcode's job is to
  **produce clean, authoritative signals**, not to adjudicate bans in the hot path.
- **Server-side kill/damage logs** double as the source of truth for stats *and* for post-match cheat
  review, and as the salvage data for aborted matches (§7.6).

---

## 9. Testing & profiling checklist (build gates)

Every networked change must pass these before merge:

- [ ] **100-bot soak:** full match with 100 AI clients on the reference server pod; sim tick holds ≥ 28 Hz.
- [ ] **Mobile bandwidth capture:** downstream ≤ target on reference device across plane → final circle.
- [ ] **Lag/jitter matrix:** playable at 50/100/150/250 ms RTT and 1/3/5% loss (netem-shaped).
- [ ] **Reconnect:** drop + rejoin within grace re-attaches with correct state; beyond grace refused.
- [ ] **Prediction correctness:** no visible rubber-banding under normal conditions; corrections smoothed.
- [ ] **Lag-comp accuracy:** automated hit-registration test at each latency bucket within tolerance.
- [ ] **Anti-cheat harness:** scripted speed/teleport/fly/rapid-fire/no-ammo/wall-shot cheats are all
      rejected server-side and emit `AnomalyEvent`.
- [ ] **Allocation loop:** Matchmaking → Agones → CreateSession → connect → MatchResult round-trips in
      staging; idempotent result retry credits exactly once.

---

## 10. Open questions / future work

- **Rollback for projectiles vs. pure server-authoritative:** current design is server-authoritative with
  cosmetic client tracers; revisit if sniper feel demands more prediction.
- **Iris vs. classic replication graph** at 100 players on target Android silicon — keep both paths until
  device profiling picks a winner.
- **Cross-region parties:** latency-fairness policy when squadmates are in different regions (current:
  place in shared best region; measure churn).
- **Spectate / kill-cam** feed derived from the `MatchEvent` stream — spec'd separately.

---

### Cross-references

- **Doc 05 — Matchmaking + Session services** (backend side of §7).
- **Doc 07 — Ranking / Stats / Inventory** (consumers of `MatchResult`).
- **Doc 09 — Security & anti-cheat** (client integrity, ban adjudication; §8 is the server-side half).
- **Doc 11 — DevOps / Infra** (Agones fleet, autoscaling, regional PoPs).
- **`packages/proto/session.proto`** — the compiled source of truth for §7.2.
