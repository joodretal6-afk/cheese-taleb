# Phoenix Client (Unreal Engine 5.6)

The mobile battle-royale client. **This module is built and tested on your own
machine** — Unreal cannot compile in the headless CI container, so the code here
is written to UE5.6 conventions and compiled/run by you in the Unreal Editor.
Everything else in `phoenix/` (services, editor, admin) is built and tested in CI.

## What's here (starter)

| File | Role |
| --- | --- |
| `PhoenixClient.uproject` | project descriptor (UE 5.6, EnhancedInput, HTTP) |
| `Source/PhoenixClient.Target.cs`, `PhoenixClientEditor.Target.cs` | build targets |
| `Source/PhoenixClient/PhoenixClient.Build.cs` | module deps (HTTP, Json, EnhancedInput) |
| `Auth/PhoenixAuthSubsystem.{h,cpp}` | **login/register against the Auth service**, holds the JWT |
| `Player/PhoenixCharacter.{h,cpp}` | on-foot pawn: move/look/jump + `F` enter-vehicle line-trace |
| `Core/PhoenixGameMode.{h,cpp}` | boots with the Phoenix character |

The `PhoenixAuthSubsystem` is the real bridge to the backend built in
`phoenix/services/auth` — it POSTs to `/auth/login` and stores the token every
other service call will carry.

## Setup (first time)

1. Install **Unreal Engine 5.6** via the Epic Games Launcher.
2. Copy this `phoenix/client/` folder somewhere outside the web repo (UE likes
   its own project root).
3. Right-click `PhoenixClient.uproject` → **Generate Visual Studio / Xcode project files**.
4. Open the `.uproject`. When prompted to rebuild `PhoenixClient`, click **Yes**.
5. Create input assets (`IA_Move`, `IA_Look`, `IA_Jump`, `IA_Interact`) and an
   `IMC_Default` mapping context, then assign them on the `BP_PhoenixCharacter`
   defaults (see `BLUEPRINTS.md`).

## Connect to the backend

```bash
# terminal 1 — start the services (from the web repo)
make -C phoenix up          # or: cd phoenix/services/auth && npm run start

# In UE, the Auth subsystem defaults to http://127.0.0.1:4001.
# On a real device use your machine's LAN IP via SetBaseUrl().
```

## Package to Android

`Platforms → Android` → set up the Android SDK/NDK in Project Settings, then
**Platforms → Android → Package Project**. See `phoenix/docs/05-ue5-client.md`
for the full mobile-graphics and packaging notes.

## Next (delivered as I write, you compile)

- Login UMG widget wired to `PhoenixAuthSubsystem` (node steps in `BLUEPRINTS.md`)
- Vehicle pawn + Chaos vehicle setup for the enter/exit flow
- Weapon component (ballistics, recoil) and the match connection flow using the
  dedicated-server contract in `phoenix/services/matchmaking/src/contract`
