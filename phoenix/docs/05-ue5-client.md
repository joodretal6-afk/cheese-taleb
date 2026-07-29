# 05 — UE5 Client (Architecture + Practical Build Guide)

> **Scope.** This is both the *architecture* for the Project Phoenix game client
> and a *step-by-step guide* for a near-beginner developer who will run Unreal
> Engine 5.6 on their own machine while an AI assistant writes the code.
>
> **Hard reality (read once, remember always):** The UE5 client **cannot be
> compiled or run in the headless Linux environment** where the backend, Map
> Editor, and Admin Dashboard are built. Every C++ change must be compiled, and
> every feature must be tested, **on the developer's own Windows/macOS machine
> with the Unreal Editor installed.** The AI writes code and gives exact click
> instructions; the developer runs the editor and reports back what happened.
>
> **Original-only rule.** No copied assets, code, sounds, maps, animations, or
> UI from PUBG, Fortnite, COD, or any other title. Everything is original or
> properly licensed (Fab / Epic-owned / CC0). This is a genre entry, not a clone.

---

## Table of contents

1. [Client architecture overview](#1-client-architecture-overview)
2. [Core framework split (GameInstance / GameMode / Controller / Pawn)](#2-core-framework-split)
3. [Character controller (mantle, slide, vault, swim, dive, parkour)](#3-character-controller)
4. [Weapon system (attachments, scopes, recoil, ballistics, penetration)](#4-weapon-system)
5. [Vehicles (cars, motorcycles, boats)](#5-vehicles)
6. [Inventory & HUD](#6-inventory--hud)
7. [Lobby, spectator, killcam, replay](#7-lobby-spectator-killcam-replay)
8. [Networking model (client side)](#8-networking-model-client-side)
9. [Login / connect flow (Auth service → matchmaking → dedicated server)](#9-login--connect-flow)
10. [Mobile graphics targets (Lumen / Nanite / VSM) — honest feasibility](#10-mobile-graphics-targets)
11. [Asset pipeline (Map Editor export, characters, weapons, vehicles)](#11-asset-pipeline)
12. [Beginner setup: install, project, folders, source control](#12-beginner-setup)
13. [How the AI delivers code (Blueprint paste + C++ files)](#13-how-the-ai-delivers-code)
14. [Build-to-Android flow](#14-build-to-android-flow)
15. [Honest division of labor (AI writes vs developer clicks)](#15-division-of-labor)
16. [Module build order & milestones](#16-module-build-order)

---

## 1. Client architecture overview

The client is a **hybrid C++/Blueprint** project. Rule of thumb we follow all
the way through:

| Written in C++ | Written in Blueprint |
| --- | --- |
| Anything performance-critical (movement, ballistics, replication, tick-heavy math) | Wiring, UI logic, designer-tweakable values, animation state machines |
| Anything security-sensitive (server-authoritative logic) | Cosmetic effects, one-off event glue |
| Base classes that Blueprints derive from | Child classes that expose tunables to the designer |

We use the **C++ base class → Blueprint child** pattern everywhere. Example:
`APhoenixCharacter` (C++) holds movement/replication; `BP_PhoenixCharacter`
(Blueprint child) holds the mesh, animation BP reference, and tuning curves.
This keeps the heavy logic in version-controllable text files and the artist-
friendly bits in the editor.

High-level module map:

```
PhoenixClient (game module, C++)
├── Core            GameInstance, GameMode, GameState, PlayerState, save/config
├── Player          PlayerController, Character, movement component, camera
├── Combat          Weapons, ballistics, damage, health/armor
├── Vehicles        Chaos vehicle pawns, boats, seat/occupant system
├── Inventory       Item defs (DataAssets), containers, equip logic
├── UI              HUD, inventory screen, lobby, map, minimap (UMG + C++ view models)
├── Net             Login subsystem, matchmaking client, connection handling
├── World           Map loader (heightmap+JSON importer), PCG spawners, loot spawns
├── Spectate        Spectator pawn, killcam, replay hooks
└── Mobile          Touch input, virtual joystick, quality scalability
```

**Golden rule of the whole client:** *the dedicated server is the authority.*
The client predicts and displays; the server decides. If the two disagree, the
server wins and the client corrects. Every design decision below flows from that.

---

## 2. Core framework split

Unreal already gives you a class skeleton. We do **not** fight it — we fill each
box with exactly the responsibility it was designed for. Beginners get this
wrong constantly, so here is the definitive table for Phoenix:

| Class | Lives where | Exists for how long | Holds | Phoenix example |
| --- | --- | --- | --- | --- |
| `UPhoenixGameInstance` | Client & server, **1 per process** | Whole app lifetime (survives level travel) | Login token, chosen loadout, backend endpoints, audio settings | Stores the JWT from Auth; owns the `ULoginSubsystem` |
| `APhoenixGameModeBase` | **Server only** | 1 per match | Match rules: player count, zone timing, win condition, spawn logic | Runs the shrinking-zone timeline, decides who won |
| `APhoenixGameState` | Server → replicated to all clients | 1 per match | Shared match state: alive count, current zone radius/center, phase | Every client reads zone info from here |
| `APhoenixPlayerState` | 1 per player, replicated to everyone | Whole match | Per-player public data: name, team, kills, alive/dead | Scoreboard reads this |
| `APhoenixPlayerController` | 1 per human, **only exists on server + owning client** | Whole match | Input, HUD ownership, camera possession, RPC endpoint | Sends fire/move input, owns the HUD widget |
| `APhoenixCharacter` (Pawn) | Replicated to all | Life of one body | The physical avatar: mesh, movement, health, held weapon | The thing you run around as |
| `UPhoenixMovementComponent` | On the character | Life of the body | All movement math, prediction, server-authoritative moves | Mantle/slide/vault/swim live here |

**Ownership & authority cheat-sheet (memorize this):**

- `HasAuthority()` is `true` on the **server** (and in single-player). Any code
  that changes real game state must be gated on it or run through a Server RPC.
- `IsLocallyControlled()` is `true` on the machine of the human driving that
  pawn. Use it for input, camera, and cosmetic-only prediction.
- A **Server RPC** (`Server_DoThing`) runs on the server, called by the owning
  client. A **Multicast RPC** runs on everyone, called by the server. A
  **Client RPC** runs on one specific client, called by the server.

```cpp
// PhoenixPlayerController.h — the RPC pattern we reuse everywhere
UCLASS()
class APhoenixPlayerController : public APlayerController
{
    GENERATED_BODY()
public:
    // Called on the client, executes on the server. Server validates, then acts.
    UFUNCTION(Server, Reliable, WithValidation)
    void Server_RequestFire(FVector_NetQuantize MuzzleLoc, FVector_NetQuantizeNormal AimDir);

    // Server tells every client to play the muzzle flash / tracer (cosmetic).
    UFUNCTION(NetMulticast, Unreliable)
    void Multicast_PlayFireFX(FVector_NetQuantize MuzzleLoc);
};
```

---

## 3. Character controller

All movement lives in **`UPhoenixMovementComponent`**, a C++ subclass of
`UCharacterMovementComponent`. We extend Unreal's built-in prediction system
rather than inventing our own, because CMC already gives us client prediction +
server reconciliation for free. We add **custom movement modes** for the special
moves.

### 3.1 Movement modes

| Move | How it works | Networking approach | AI/Dev split |
| --- | --- | --- | --- |
| **Walk / run / crouch / prone** | Built into CMC; we just tune values | Native CMC prediction | AI sets values; dev tests feel |
| **Sprint** | Speed multiplier + stamina drain | Predicted (custom move flag) | AI writes; dev tunes stamina |
| **Slide** | Enter `CMOVE_Slide`; apply downhill accel + friction curve; exit on stop/jump | Custom `FSavedMove` flag so it predicts | AI writes C++; dev tunes curve |
| **Mantle / climb** | Trace forward+up for a ledge; if valid, play root-motion montage moving character to ledge top | Motion-warping montage; **server validates the trace** | AI writes trace + montage trigger; dev sets warp targets on the anim |
| **Vault** | Short version of mantle over waist-high objects | Same as mantle | Same |
| **Parkour (steps, over-under)** | Library of context montages chosen by the forward/up traces | Montage + motion warp | AI writes selection logic; dev slots montages |
| **Swim** | CMC `MOVE_Swimming` triggered by a `PhysicsVolume` marked as water | Native | Dev paints water volumes; AI enables |
| **Dive (underwater)** | Custom depth control + oxygen meter; camera post-process underwater | Predicted vertical input; oxygen replicated | AI writes oxygen + control; dev sets post-process |

**Why root motion + motion warping for mantle/vault/parkour?** Hand-coding a
character sliding up a ledge looks robotic and de-syncs online. Instead we play
a hand-authored animation (root motion) and use **Motion Warping** to bend that
animation so the hands land exactly on *this* ledge. The AI writes the trace
that finds the ledge and sets the warp target; the developer confirms the anim
lines up in the editor.

```cpp
// Simplified mantle detection (runs on owning client, re-validated on server)
bool UPhoenixMovementComponent::TryMantle()
{
    const FVector Fwd = UpdatedComponent->GetForwardVector();
    const FVector Start = UpdatedComponent->GetComponentLocation();

    FHitResult WallHit;
    // 1) Is there a wall in front at chest height?
    if (!TraceForward(Start, Fwd, WallHit)) return false;

    // 2) Is there a walkable surface on top of it?
    FHitResult TopHit;
    if (!TraceLedgeTop(WallHit, TopHit)) return false;

    // 3) Enough headroom for the character?
    if (!HasHeadroom(TopHit.Location)) return false;

    // Hand the ledge transform to the anim system via Motion Warping,
    // then play the montage. Server does the same traces to confirm.
    SetMantleTarget(TopHit.Location, WallHit.ImpactNormal);
    PlayMantleMontage();
    return true;
}
```

### 3.2 Anim Blueprint

The animation graph (locomotion blendspace, aim offset, montage slots for
mantle/vault/reload) is authored **in the editor by the developer** using an
**Animation Blueprint** child of a C++ `UPhoenixAnimInstance`. The C++ base
computes speed, direction, lean, IsInAir, IsCrouched, etc., once per frame and
exposes them; the Anim BP graph consumes them. This keeps the math testable and
the artistry visual.

---

## 4. Weapon system

Weapons are **data-driven**. A gun is not a hardcoded class per model — it is a
`UWeaponDataAsset` (a `UPrimaryDataAsset`) plus one generic `AWeaponActor`. Add
a new gun = add a new data asset, no new code.

### 4.1 Data model

```cpp
// WeaponDataAsset.h
UCLASS(BlueprintType)
class UWeaponDataAsset : public UPrimaryDataAsset
{
    GENERATED_BODY()
public:
    UPROPERTY(EditDefaultsOnly, Category="Identity")
    FName WeaponId;                 // "AR_Falcon" (original name)

    UPROPERTY(EditDefaultsOnly, Category="Ballistics")
    float MuzzleVelocity = 880.f;   // m/s — bullets are projectiles, not hitscan

    UPROPERTY(EditDefaultsOnly, Category="Ballistics")
    float BaseDamage = 38.f;

    UPROPERTY(EditDefaultsOnly, Category="Ballistics")
    float DamageFalloffPer100m = 4.f;

    UPROPERTY(EditDefaultsOnly, Category="Fire")
    float RoundsPerMinute = 620.f;

    UPROPERTY(EditDefaultsOnly, Category="Recoil")
    UCurveVector* RecoilPattern = nullptr;   // per-shot pitch/yaw

    UPROPERTY(EditDefaultsOnly, Category="Attachments")
    TArray<EAttachmentSlot> AllowedSlots;    // Muzzle, Optic, Grip, Mag, Stock

    UPROPERTY(EditDefaultsOnly, Category="Penetration")
    float PenetrationPower = 1.0f;   // how many "material thickness" units it punches through
};
```

### 4.2 Ballistics — projectile, not hitscan

Real BR feel needs **bullet travel time and drop**. We simulate bullets as
lightweight projectiles (custom fast-trace stepper, not a full `AActor` per
bullet — that would murder mobile perf). Each tick a bullet advances by
`velocity * dt`, applies gravity, and does a segment trace for the step.

- **Bullet drop:** gravity applied each step → aim high at range.
- **Falloff:** `damage = BaseDamage - (distance/100m) * DamageFalloffPer100m`.
- **Server authority:** the **server** runs the authoritative bullet. The client
  fires a predicted tracer immediately for feel, but the hit that counts is the
  server's. This is standard and prevents "I shot first" cheating.

### 4.3 Penetration

When a bullet's segment trace hits geometry, we check the surface's
`PhysicalMaterial` (wood / metal / concrete / flesh / glass). Each material has
a **thickness cost**. If `PenetrationPower` remains after subtracting the cost,
the bullet exits the far side (second trace) with reduced power and damage and
continues. Glass and wood penetrate; concrete and steel usually stop rounds.

```
bulletPower = weapon.PenetrationPower
for each surface hit along the ray:
    cost = surface.material.thicknessCost * surface.penetratedDepth
    if bulletPower <= cost: STOP (bullet embeds)
    bulletPower -= cost
    damage      *= surface.material.damageRetain   // e.g. 0.6 after wood
    continue through to exit point
```

### 4.4 Recoil & spray control

Recoil is a **deterministic pattern + small random spread**, driven by
`RecoilPattern` (a `UCurveVector` sampled by shot index). Deterministic patterns
are what let skilled players learn a spray. Recovery lerps the camera back
between shots. All original patterns — we do not copy any real gun's spray.

### 4.5 Attachments & scopes

Attachments are also **data assets** that modify the weapon's stats and swap a
mesh onto a named socket:

| Slot | Effect | Example |
| --- | --- | --- |
| Muzzle | recoil/loudness/flash | Compensator, Suppressor |
| Optic | ADS zoom + reticle (render-target scope) | Red dot, 4x, 8x |
| Grip | horizontal/vertical recoil | Vertical, Angled |
| Mag | ammo capacity, reload speed | Extended, Quickdraw |
| Stock | recoil recovery, ADS speed | Tactical Stock |

**Scopes with real zoom** (4x/8x) use a **SceneCaptureComponent2D** rendering
into a **render target** displayed on the scope lens material — a true optical
zoom, not a fake overlay. On low-end mobile we fall back to a **magnified UMG
overlay** (cheaper, no second scene render). The AI writes both paths; the
quality setting picks one.

**AI writes:** weapon actor, ballistics stepper, penetration, recoil sampling,
attachment stat-merge. **Dev clicks:** creates the DataAssets, assigns meshes to
sockets, tunes RPM/damage, and confirms the scope render target looks right.

---

## 5. Vehicles

Vehicles use **Chaos Vehicles** (UE5's built-in physics vehicle plugin). A
`WheeledVehiclePawn` subclass handles cars, motorcycles, and (with a water
surface + buoyancy) we build boats on a floating pawn.

| Vehicle | Base | Key config | Notes |
| --- | --- | --- | --- |
| **Car** | `AWheeledVehiclePawn` + `UChaosVehicleMovementComponent` | 4 wheels, engine curve, gearbox | Standard |
| **Motorcycle** | Same, 2 wheels + lean logic | Balance assist so it doesn't fall over at rest | Lean into turns |
| **Boat** | Floating pawn + buoyancy pontoons + thruster | Point buoyancy samples against water height; propeller force | No wheels |

**Seats / occupancy:** a `USeatComponent` array on the vehicle. Entering =
Server RPC → server possesses/attaches the character to a seat, replicates it.
The driver's input drives the movement component; passengers can still shoot.

**Networking vehicles is hard** because physics is non-deterministic. We use
UE5's **network physics prediction** for the driver and **replicate the vehicle
state** (transform + wheel/velocity) to passengers and nearby players. Expect to
spend real tuning time here; it is the trickiest networked system in the client.

**AI writes:** pawn classes, seat/enter-exit RPCs, boat buoyancy, input mapping.
**Dev clicks:** builds the physics asset, sets wheel bones, tunes the engine/
suspension curves in the editor (very hands-on, trial and error).

---

## 6. Inventory & HUD

### 6.1 Inventory

Items are `UItemDataAsset`s (weapons, ammo, heals, armor, attachments,
throwables). The player's inventory is a **replicated array of item instances**
on the `APhoenixCharacter` (or a dedicated `UInventoryComponent`).

- **Server-authoritative:** pickups, drops, swaps are Server RPCs. Client shows a
  predicted result instantly, server confirms.
- **Ground loot** is spawned by the world loot system (see §11) and represented
  by lightweight loot actors; picking up moves the item into the inventory
  component and destroys/updates the ground actor on the server.
- Stacking, weight/slot limits, and equip logic live in the component (C++);
  the *look* of the inventory screen is UMG (developer-built, C++ view model).

### 6.2 HUD

Built with **UMG** (Unreal's UI system). A C++ `UPhoenixHUDWidget` base exposes
data (health, ammo, alive count, zone timer, minimap data); the visual widget is
a Blueprint child the developer lays out. Core widgets:

| Widget | Shows |
| --- | --- |
| Health/armor/boost bars | Player vitals |
| Ammo + fire mode | Current weapon |
| Minimap + full map | Player pos, zone circle, teammates, pings |
| Compass | Heading + ping markers |
| Alive counter / kill feed | Match state (from GameState) |
| Inventory screen | Grid of items, equip slots, attachments |
| Damage indicators | Direction of incoming fire |

**Mobile:** the HUD *is* the controls — virtual joystick (move), fire button,
ADS, jump/crouch, lean, item wheel. Built with UMG touch widgets + the
**Enhanced Input** system. This is a big chunk of dev clicking (layout) with AI
writing the binding logic.

---

## 7. Lobby, spectator, killcam, replay

### 7.1 Lobby

The **lobby is a separate level** (`L_Lobby`) loaded after login. It is a normal
UE map showing the player's character, loadout selection, party/squad UI, and a
"Find Match" button that talks to the **Matchmaking service** (see §9). When a
match is found, the client does a **`ClientTravel`** to the dedicated server's
address. The lobby is client-side/cosmetic; nothing here is competitive.

### 7.2 Spectator

On death, the `PlayerController` switches to a **spectator pawn**. Modes:
free-cam, follow-teammate (in squads), or follow-killer. The server keeps dead
players connected as spectators until the match ends or they leave. Spectator
sees only what the server allows (no wallhack via spectating enemies unless it's
the killcam).

### 7.3 Killcam

A **short local replay** of the last few seconds from the killer's viewpoint,
shown to the victim. Implemented with UE5's **Replay/DemoNet system** recording a
rolling buffer; on death we scrub the buffer to `deathTime - 4s` and play it back
from the killer's camera. Optional for v1 — it depends on the replay system
being wired (below), so we schedule it after core replay works.

### 7.4 Replay system

UE5 ships a **Replay (DemoNet)** framework: it records the network stream to a
file and replays it deterministically. We enable it for:
- **Killcam** (rolling in-memory buffer),
- **Match replays** (saved file, optional download from backend),
- **Anti-cheat review** (server-side recordings the Admin Dashboard can request).

**AI writes:** spectator controller logic, killcam scrub trigger, replay
start/stop hooks. **Dev clicks:** enables the Replay plugin, tests playback,
confirms cameras.

---

## 8. Networking model (client side)

This is the heart of a BR and where beginners lose the most time. Keep the
mental model simple:

```
          INPUT                         AUTHORITY                    DISPLAY
   ┌──────────────────┐        ┌───────────────────────┐     ┌──────────────────┐
   │ Owning client     │ RPC → │  Dedicated server      │  →  │ All clients       │
   │ predicts movement │        │  simulates the truth   │ rep │ interpolate/       │
   │ & fire locally    │ ←corr │  validates & replicates │     │ correct to truth   │
   └──────────────────┘        └───────────────────────┘     └──────────────────┘
```

### 8.1 The three pillars

1. **Replication** — the server marks properties `UPROPERTY(Replicated)` (health,
   zone radius, inventory) and they auto-sync to clients. Actors have relevancy/
   priority so far-away players cost less bandwidth.
2. **Client-side prediction** — the owning client moves *immediately* on input
   (no waiting for the round trip), using UE5's CharacterMovementComponent
   prediction. It stores each move; when the server's authoritative position
   arrives, if they disagree beyond a threshold the client **replays** its
   pending moves from the corrected position (reconciliation). The player rarely
   sees this.
3. **Server-authoritative movement** — the server is the only truth. A hacked
   client that claims "I'm flying" gets snapped back because the server re-runs
   the same movement code and rejects impossible moves.

### 8.2 What is predicted vs authoritative

| System | Client predicts? | Server authoritative? |
| --- | --- | --- |
| Own movement (walk/slide/mantle) | Yes (feels instant) | Yes (corrects) |
| Firing (tracer/muzzle FX) | Yes (cosmetic only) | Yes (the *hit* is server-side) |
| Damage / kills | No | Yes, always |
| Inventory pickup | Yes (optimistic UI) | Yes (confirms) |
| Zone / match state | No (read replicated) | Yes |
| Other players' movement | No — interpolated | Yes |

### 8.3 Lag compensation

The server rewinds hitboxes to the time the shooter *actually* fired (accounting
for their ping) before checking a hit — so shots that looked good on the
shooter's screen count, without letting high-ping players teleport. UE5 gives us
building blocks; the exact rewind buffer is server-side game code (documented in
the dedicated-server contract doc, #06). The client's job is to timestamp fire
requests accurately.

### 8.4 Anti-cheat posture on the client

Client never decides damage, never decides loot, never trusts client-sent
positions blindly. All of that is enforced server-side. The client just sends
*intent* (I want to move here, I want to fire), and the server validates. This
is baked into every RPC (`WithValidation`).

---

## 9. Login / connect flow

The client talks to the **backend services** (built in the Linux environment)
over HTTPS/WebSocket. UE5's `HTTP` module + a small `ULoginSubsystem`
(GameInstance subsystem) handle it. **The client never talks to the database —
only to services.**

### 9.1 Full flow (login → playing)

```
1. App launch → Title screen
2. Player enters credentials (or OAuth) →
   POST https://api.phoenix/…/auth/login   (Auth service)
   ← { accessToken (JWT), refreshToken, playerId }
3. Store tokens in UPhoenixGameInstance / ULoginSubsystem (memory + secure store)
4. GET  /profile, /inventory  (Profile & Inventory services, Bearer JWT)
   ← player name, cosmetics, owned items → populate Lobby
5. Load L_Lobby, player picks loadout, presses "Find Match"
6. POST /matchmaking/queue  (Matchmaking service, Bearer JWT)
   ← poll / WebSocket: "MATCH_FOUND { serverIp, serverPort, matchToken }"
7. Client: ClientTravel("serverIp:serverPort?token=matchToken")
   → connects to the DEDICATED SERVER (UE5 server build)
8. Dedicated server validates matchToken with the backend, admits the player
9. Gameplay. On match end → results POSTed by server → client returns to Lobby
```

### 9.2 Login code shape

```cpp
// LoginSubsystem.h  (UGameInstanceSubsystem)
void ULoginSubsystem::Login(const FString& Email, const FString& Password)
{
    TSharedRef<IHttpRequest> Req = FHttpModule::Get().CreateRequest();
    Req->SetURL(BackendBaseUrl + TEXT("/auth/login"));
    Req->SetVerb(TEXT("POST"));
    Req->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Req->SetContentAsString(MakeLoginJson(Email, Password));
    Req->OnProcessRequestComplete().BindUObject(this, &ULoginSubsystem::OnLoginResponse);
    Req->ProcessRequest();
}

void ULoginSubsystem::OnLoginResponse(FHttpRequestPtr, FHttpResponsePtr Resp, bool bOk)
{
    if (bOk && Resp->GetResponseCode() == 200)
    {
        // parse JSON → store AccessToken, RefreshToken, PlayerId on GameInstance
        // broadcast OnLoginSucceeded → UI transitions to Lobby
    }
    else { /* broadcast OnLoginFailed(reason) → UI shows error */ }
}
```

The endpoints, token shape, and error codes come from the **Auth service** doc.
The AI keeps this client subsystem in sync with the service contract.

### 9.3 Config, not hardcode

Backend URLs live in a config (`DefaultGame.ini` / a `UDataAsset`), with dev /
staging / prod variants — never hardcoded in a Blueprint. Tokens are held in
memory for the session and in the platform secure store (Keychain / Keystore)
for refresh.

---

## 10. Mobile graphics targets

**This is where honesty matters most.** UE5's headline features (Lumen, Nanite,
Virtual Shadow Maps) are built for PC and current-gen consoles. On phones they
range from "expensive" to "not supported." Here is the real picture for a
**battle royale** (100 players, large map, needs a stable frame rate more than
it needs cinematic lighting):

| Feature | Dev PC (Windows) | High-end phone (flagship, 2023+) | Mid/low phone | Verdict for Phoenix mobile |
| --- | --- | --- | --- | --- |
| **Nanite** (virtualized geometry) | Yes, great | Requires very new GPUs + heavy cost; **not viable at 100-player scale** | No | **Off on mobile.** Use classic LOD meshes. |
| **Lumen** (dynamic GI/reflections) | Yes | Extremely expensive; kills battery/thermals in a BR | No | **Off on mobile.** Baked lighting + simple dynamic. |
| **Virtual Shadow Maps** | Yes | Costly; unstable perf at scale | No | **Off on mobile.** Use cascaded shadow maps, tight distance. |
| **Deferred renderer** | Yes | Heavy on mobile | No | Use the **Mobile Forward+/Forward renderer** on phones |
| **MetalRHI / Vulkan** | — | iOS = Metal, Android = Vulkan | Same | Target Vulkan (Android) / Metal (iOS) |
| Screen-space effects, contact shadows | Yes | Selectively, low quality | Off | Scalability-gated |

### 10.1 The honest strategy: two rendering profiles

- **Dev / Windows build** — you *can* turn Lumen/Nanite on to see the map look
  gorgeous while authoring, and for a potential PC build. Great for screenshots
  and iteration.
- **Shipping mobile build** — **baked/static lighting**, LOD meshes (no Nanite),
  cascaded shadow maps, mobile forward renderer, aggressive LODs and cull
  distances, texture streaming budgets. Target **60 FPS on flagships, 30–45 FPS
  on mid-tier**, with a **Quality Settings menu** (Smooth/Balanced/HD/Ultra HD +
  frame-rate cap) exactly like every shipping mobile BR.

### 10.2 What actually makes a mobile BR run

Not fancy lighting — it's **scale management**: LODs, HLOD (hierarchical LOD for
distant clusters), significance-based tick throttling for far players, texture
streaming pools, occlusion culling, capped particle counts, and a hard poly/draw-
call budget. The AI configures these in `.ini` scalability groups; the developer
profiles on a real device with **Unreal Insights / `stat unit`** and reports the
numbers back so we tune.

> **Bottom line:** Don't promise Lumen/Nanite on a phone BR. We author with them
> optionally on PC and **ship baked, LOD-based, forward-rendered** on mobile.
> That's what real mobile BRs do, and it's the difference between a slideshow and
> a shippable game.

---

## 11. Asset pipeline

### 11.1 Importing a map from the web Map Editor

The **web Map Editor** (built in the Linux env, module #2) exports a map as
**a heightmap image + a JSON scene description**. The UE5 client imports both:

**Export bundle (from the editor):**

```
map_erangel-original/           (original name, not a copied map)
├── heightmap.png               16-bit grayscale, power-of-two+1 (e.g. 4033×4033)
├── weightmaps/                 optional splat layers (grass/rock/sand/road)
│   ├── grass.png
│   └── rock.png
└── scene.json                  everything else, data-driven
```

**`scene.json` shape (contract between editor and client):**

```json
{
  "schemaVersion": 1,
  "mapId": "erangel-original",
  "worldSize":   { "x": 8000, "y": 8000, "z": 1500 },   // meters
  "heightScale": 1500,
  "water": [ { "type": "sea",  "level": 0.0 },
             { "type": "lake", "bounds": [ ... ], "level": 12.0 } ],
  "roads":  [ { "spline": [ [x,y],[x,y], ... ], "width": 6 } ],
  "biomes": [ { "region": [ ... ], "type": "forest", "density": 0.6 } ],
  "actors": [
    { "type": "building",  "assetId": "bld_warehouse_a",
      "transform": { "loc": [x,y,z], "rot": [p,y,r], "scale": 1.0 } },
    { "type": "loot_zone", "tier": "high", "bounds": [ ... ] },
    { "type": "vehicle_spawn", "vehicle": "car", "loc": [x,y,z] }
  ],
  "playerSpawns": [ [x,y,z], ... ],
  "safeZonePlan": { "phases": [ { "radius": ..., "delay": ... } ] }
}
```

**Import pipeline in UE5 (two stages):**

1. **Landscape import (mostly manual, one-time per map version).**
   - Developer: *Landscape Mode → Import from File → heightmap.png*, set the
     scale from `worldSize`/`heightScale`, import weightmaps as layers.
   - This is a **developer-clicks** step because UE's landscape import is an
     editor operation. The AI provides the exact numbers to type.

2. **Data-driven actor spawning (automated by our tooling).**
   An editor utility / commandlet the **AI writes** reads `scene.json` and:
   - spawns each `actor` by looking up `assetId` in an **Asset Registry table**
     (maps `"bld_warehouse_a"` → a UE mesh/Blueprint),
   - places roads via spline meshes,
   - registers loot zones, vehicle spawns, player spawns, and the safe-zone plan
     into the GameMode's data.
   - For scattered natural cover (trees, rocks, grass) we use **PCG (Procedural
     Content Generation)** driven by the `biomes` data, so we don't hand-place
     thousands of props.

```cpp
// MapImporter — Editor Utility (runs in-editor, AI-written)
void UPhoenixMapImporter::ImportScene(const FString& JsonPath)
{
    FSceneDef Scene = ParseSceneJson(JsonPath);          // read the contract
    for (const FActorDef& A : Scene.Actors)
    {
        UClass* ToSpawn = AssetRegistryTable->Resolve(A.AssetId);  // id → asset
        if (!ToSpawn) { LogMissingAsset(A.AssetId); continue; }
        GetWorld()->SpawnActor(ToSpawn, &A.Transform);
    }
    BuildRoads(Scene.Roads);          // spline meshes
    ConfigureLoot(Scene.Actors);      // loot zones → loot system
    ConfigurePCGBiomes(Scene.Biomes); // hand density to PCG graphs
    SaveGameModeMapData(Scene);       // spawns, zone plan → data asset
}
```

> **Key idea:** the editor decides *what and where*; the client owns *the actual
> art*. `assetId` is a stable string both sides agree on. Change art without
> touching the map; change the map without touching art.

### 11.2 Getting original characters / weapons / vehicles in

**Everything must be original or properly licensed.** Sources, in order of
preference:

| Source | What | License note |
| --- | --- | --- |
| **Fab** (Epic's marketplace) | Meshes, animations, materials, VFX | Check each item's license allows game distribution; many are Epic-licensed for UE games |
| **Epic-owned free content** (Quixel Megascans via Fab, Paragon assets, Manny/Quinn skeleton) | Environments, sample characters, skeleton | Free for UE projects |
| **Commissioned / original art** | Bespoke characters, weapons, vehicles | You own it — best for a real product |
| **CC0 libraries** | Placeholder / prototype assets | Verify CC0, keep attribution log |
| ❌ Ripped game assets | — | **Never.** Legal and moral no. |

**Import formats:**

- **FBX** — the standard for skeletal meshes (characters) + animations, and
  static meshes (weapons, props). Import via *Content Browser → Import*.
- **glTF/GLB** — supported via the Interchange/glTF importer; good for meshes
  from web/DCC tools.
- **Textures** — PNG/TGA; pack ORM (Occlusion-Roughness-Metallic) for mobile.

**Rig compatibility:** original characters should share a **common skeleton**
(e.g. UE's Manny/Quinn skeleton or one bespoke skeleton) so all animations
(mantle, reload, vault) retarget across every character. This is a big
time-saver and mostly a **developer-clicks** retargeting step in the editor
(IK Retargeter), with the AI advising the process.

**Weapons** attach to hand/muzzle **sockets** on the character skeleton and hold
their own **attachment sockets** (muzzle, optic, grip, mag) — configured in the
editor by the developer; sizes/offsets fed by the AI.

---

## 12. Beginner setup

### 12.1 Install Unreal Engine 5.6

1. Go to **unrealengine.com** → download the **Epic Games Launcher** (Windows or
   macOS). *(UE5 client work needs Windows or a Mac — not the Linux env.)*
2. Install the launcher, sign in with an Epic account (free).
3. In the launcher: **Unreal Engine → Library → + → install version 5.6**.
   - **Storage:** UE5.6 + a project is **~100+ GB**. Have a fast SSD with 150 GB
     free.
   - During install, under **Options**, enable **Android** and (on Mac) **iOS**
     target platforms if offered — this saves setting them up later.
4. **Visual Studio 2022** (Windows) with the *"Game development with C++"* and
   *".NET desktop"* workloads — UE needs it to compile C++. On Mac, install
   **Xcode**.

> If any step differs from what you see, tell the AI exactly what's on screen and
> it will adjust. The launcher UI changes between versions.

### 12.2 Create the project

1. Epic Launcher → **Launch** UE5.6.
2. **Games → Third Person** template, **C++** (not Blueprint), **Target: Mobile**,
   **Scalable** quality, **no starter content** (keeps it lean).
3. Name it **`Phoenix`**, location = a short path like `D:\Dev\Phoenix`
   (long/space-y paths cause Windows build issues).
4. First launch compiles C++ (a few minutes). When the editor opens, you have a
   running project.

### 12.3 Folder structure

Two folder worlds exist — **on disk** (C++ source, config) and **in the Content
Browser** (assets). Keep both tidy:

```
Phoenix/                         (on disk — this goes in git)
├── Source/PhoenixClient/        C++ (AI writes files here)
│   ├── Core/  Player/  Combat/  Vehicles/  Inventory/  UI/  Net/  World/ ...
├── Config/                      DefaultEngine.ini, DefaultGame.ini (settings)
├── Content/                     .uasset files (binary — see git note below)
│   ├── Characters/  Weapons/  Vehicles/  Maps/  UI/  FX/  Audio/
├── Phoenix.uproject
└── .gitignore / .gitattributes
```

Mirror the Content Browser folders to the C++ module folders so things are easy
to find.

### 12.4 Source control

Git works, **but UE assets are large binary files** — use **Git LFS**.

`.gitignore` (do **not** commit these — they regenerate):
```
Binaries/  DerivedDataCache/  Intermediate/  Saved/  .vs/  *.sln
```

`.gitattributes` (track binaries with LFS):
```
*.uasset filter=lfs diff=lfs merge=lfs -text
*.umap   filter=lfs diff=lfs merge=lfs -text
*.fbx    filter=lfs diff=lfs merge=lfs -text
*.png    filter=lfs diff=lfs merge=lfs -text
```

Commit: `Source/`, `Config/`, `Content/`, `*.uproject`, `.gitattributes`,
`.gitignore`. The client lives under **`phoenix/client/`** in the monorepo (per
the README layout). **Never edit the same `.uasset` on two machines at once** —
binary assets can't be merged. Coordinate; lock if using Perforce later (a real
studio would use Perforce, but Git+LFS is fine for one dev).

---

## 13. How the AI delivers code

The AI can't touch your machine. It delivers work in **exactly two forms**, and
you apply them.

### 13.1 C++ source files (the main channel)

The AI writes complete `.h`/`.cpp` files. You:
1. Save them into `Source/PhoenixClient/<Folder>/` at the path the AI specifies.
2. In the editor: **Tools → Refresh Visual Studio Project** (or right-click the
   `.uproject`).
3. **Compile**: click **Compile** in the editor toolbar, or build in Visual
   Studio. Report any errors back verbatim — the AI fixes them.

New C++ **classes** ideally start via the editor's **Tools → New C++ Class**
wizard (so UE registers the module files), then the AI fills the body. For added
files the AI provides the full content; you paste and compile.

### 13.2 Blueprint node text via copy-paste (Ctrl+V)

**Little-known but crucial:** Blueprint graphs are **plain text on the
clipboard.** If you copy Blueprint nodes, you get text like:

```
Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="K2Node_Event_0"
   ...
End Object
```

The AI can **write that text**, you **select it, copy it, then Ctrl+V inside an
open Blueprint graph** — and the nodes appear, wired up. This is how the AI
delivers Blueprint logic without being at your machine.

**Workflow:**
1. AI gives you a block of Blueprint node text (and says which Blueprint/graph).
2. Open that Blueprint, click in the graph, **Ctrl+V**.
3. The nodes materialize. Reconnect any variable references it warns about.
4. Compile the Blueprint, test, report back.

> Node text can be finicky across versions (a variable it references must exist).
> The AI will tell you which variables/functions to create first. When paste is
> impractical, the AI gives **precise click-by-click node instructions** instead.

### 13.3 Config & data

`.ini` settings, DataAsset field values, and scalability groups are delivered as
exact text/values to type into the editor or paste into `Config/*.ini`.

---

## 14. Build-to-Android flow

Once a feature runs in the editor (**Play In Editor**), you can build to a real
phone. Order of operations:

### 14.1 One-time Android setup

1. In the editor: **Edit → Plugins** — ensure **Android** support is on.
2. **Edit → Project Settings → Platforms → Android → "Configure Now"** (accepts
   the SDK license, sets package name, etc.).
3. Install Android tooling. UE5.6 ships a script — **Turnkey** (Platforms menu →
   Android → *Update Android SDK*) installs the correct SDK/NDK/JDK versions.
   *(Wrong SDK/NDK versions are the #1 Android build headache — let Turnkey pick
   them.)*
4. On the phone: enable **Developer Options → USB debugging**, plug in via USB,
   accept the RSA prompt. Confirm with `adb devices`.

### 14.2 Project settings for mobile (AI provides values)

- **Platforms → Android:** package name `com.yourstudio.phoenix`, min SDK,
  target SDK, **Vulkan** rendering, arm64 only.
- **Engine → Rendering:** mobile forward renderer, **Lumen/Nanite/VSM OFF for
  mobile** (per §10), MSAA/anti-alias mobile setting, texture compression ASTC.
- **Scalability:** the mobile quality profiles.

### 14.3 Build & run

- **Fast iteration:** **Platforms → Android → Launch → (your device)** — cooks +
  installs + runs directly. Use this while developing.
- **Shippable package:** **Platforms → Android → Package Project** → produces an
  **`.apk`** (or **`.aab`** for the Play Store). Install `.apk` manually with
  `adb install Phoenix.apk`.

### 14.4 Expect friction

The first Android build **will** fail once or twice (SDK path, license, package
name). This is normal. Copy the full build log to the AI; it diagnoses and gives
the fix. Budget a half-day for the first successful device build; afterward it's
routine.

---

## 15. Division of labor

The single most important table in this doc. **Anything requiring the Unreal
Editor GUI, physics tuning, art, or a real device is the developer.** Anything
that is text (code, config, node text, values) is the AI.

| Area | AI writes / provides | Developer clicks / does |
| --- | --- | --- |
| **Setup** | Exact settings, versions, folder layout, `.gitignore`/`.gitattributes` | Installs UE/VS, creates project, installs LFS |
| **C++ systems** | All `.h`/`.cpp` (movement, weapons, ballistics, net, inventory, importer) | Creates class via wizard, saves files, **compiles**, reports errors |
| **Blueprints** | Node text to Ctrl+V, or click-by-click node instructions | Pastes/wires nodes, sets variable defaults, compiles BP |
| **Animation** | Which montages/slots/notifies to create, C++ anim base | Builds Anim BP graph, imports/retargets anims, sets motion-warp targets |
| **Vehicles** | Pawn/seat code, buoyancy, input | Builds physics assets, tunes wheel/engine/suspension curves (hands-on) |
| **Weapons** | Weapon actor, ballistics, recoil, penetration, attach logic | Creates DataAssets, assigns meshes to sockets, tunes values |
| **Map import** | The importer commandlet + `scene.json` contract | Landscape import (heightmap), runs importer, fixes missing-asset warnings |
| **Art / assets** | Naming, socket/scale guidance, licensing rules | Imports FBX/GLB, sets materials, retargets rigs, verifies **original-only** |
| **UI/HUD** | View-model C++, binding logic, layout guidance | Lays out UMG widgets, wires touch controls, styles |
| **Networking** | Replication setup, RPCs, prediction config | Tests in PIE with 2+ players, reports desyncs |
| **Graphics** | Scalability `.ini`, quality profiles | Profiles on device (`stat unit`, Insights), reports FPS |
| **Backend connect** | Login subsystem, HTTP calls matching service contracts | Enters real endpoints/config, tests against running services |
| **Android build** | Every setting value, log diagnosis | Runs Turnkey, connects device, packages, sends logs back |

**The loop, every feature:** AI writes → dev applies & compiles → dev runs in
editor → dev reports (screenshot / log / "feels floaty") → AI adjusts → repeat.
Small increments. Never "here's 5000 lines, good luck."

---

## 16. Module build order

Build the client in this dependency order — each piece running before the next.
Mirrors the studio approach in the root README (client = roadmap item 8).

| # | Milestone | You can verify when… |
| --- | --- | --- |
| 1 | Project + framework skeleton (GameInstance/Mode/State/Controller/Character) | Character runs around a test level in PIE |
| 2 | Core movement + camera (walk/run/crouch/jump/sprint) | Feels right on keyboard + touch |
| 3 | Advanced movement (slide, mantle, vault, parkour, swim, dive) | Each move works in PIE, predicts online |
| 4 | Weapon system (data-driven gun, projectile ballistics, recoil) | Can shoot a target; damage registers server-side |
| 5 | Attachments, scopes, penetration | Swap optics/mags; 4x scope zooms; bullets pen wood |
| 6 | Inventory + HUD (mobile controls) | Pick up/drop/equip; HUD shows vitals/ammo/map |
| 7 | Networking hardened (2-player PIE, dedicated server connect) | Two clients see each other correctly; server authoritative |
| 8 | Login flow → Lobby → Matchmaking → ClientTravel to dedicated server | Real login against Auth service; match found; join server |
| 9 | Map import pipeline (heightmap + `scene.json` → playable level) | Editor-exported map loads with buildings/loot/spawns |
| 10 | Vehicles (car, motorcycle, boat) | Drive/ride/sail; seats + networking work |
| 11 | Spectator + killcam + replay | Death → spectate; killcam plays; replay records |
| 12 | Mobile graphics pass + device build (Android APK) | 30–60 FPS on a real phone; APK installs and runs |
| 13 | Polish, LiveOps hooks, anti-cheat client posture, store integration | End-to-end match on device against live backend |

---

### Appendix A — Quick glossary for the beginner

| Term | Plain meaning |
| --- | --- |
| **PIE** | "Play In Editor" — hit Play, test instantly without building |
| **Pawn / Character** | The thing you control in the world |
| **Controller** | The "brain/input" possessing a pawn |
| **Replication** | Auto-syncing a value from server to clients |
| **RPC** | A function call sent across the network (client↔server) |
| **Prediction** | Client acts instantly, server corrects if wrong |
| **UMG** | Unreal's UI (buttons, bars, menus) |
| **DataAsset** | A data-only asset (a gun's stats) — no code needed to add one |
| **Nanite / Lumen / VSM** | High-end PC rendering features — **off on mobile** |
| **Cook / Package** | Convert project into a build for a device (APK) |
| **Turnkey** | UE's tool that installs the right Android SDK/NDK for you |
| **Git LFS** | Git extension for large binary files (UE assets) |

### Appendix B — Original-only checklist (run before importing any asset)

- [ ] Do I have the right to use this in a commercially distributed game?
- [ ] Is it from Fab/Epic-free/commissioned/CC0 — **not** ripped from another game?
- [ ] Is the name original (no "Erangel", no real gun trademarks, no real car brands)?
- [ ] Logged in the attribution/license record?
- [ ] If unsure → don't import; ask.

> When in doubt, treat it as copyrighted. A shippable product is worth more than
> a shortcut that gets it taken down.
