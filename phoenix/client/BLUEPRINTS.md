# Blueprint wiring — Phoenix Client

Step-by-step node graphs for the parts that live in Blueprint. The C++ does the
heavy lifting (auth HTTP, movement, interact); Blueprint just wires UI and input
to it. Do these in the Unreal Editor after the project compiles.

---

## 1. Input assets (Enhanced Input)

1. **Content Browser → Add → Input → Input Action** ×4:
   `IA_Move` (Value type: **Axis2D**), `IA_Look` (**Axis2D**), `IA_Jump` (**Digital/bool**),
   `IA_Interact` (**Digital/bool**).
2. **Add → Input → Input Mapping Context** → `IMC_Default`. Add mappings:
   - `IA_Move` → **W/A/S/D** (use the 2D-vector modifiers, or a Left Thumbstick on mobile)
   - `IA_Look` → **Mouse XY** (or Right Thumbstick)
   - `IA_Jump` → **Space** (or an on-screen button)
   - `IA_Interact` → **F** (or an on-screen "Enter" button)
3. Create **`BP_PhoenixCharacter`** from `PhoenixCharacter`. In its Class Defaults,
   set `Mapping Context = IMC_Default`, and assign the four Input Actions.
4. Set `BP_PhoenixCharacter` as Default Pawn on your GameMode (or keep the C++
   `APhoenixGameMode`, which already does this).

> The enter-vehicle line-trace on `F` is already in C++ (`APhoenixCharacter::Interact`).
> Nothing to wire — pressing `IA_Interact` near a Pawn possesses it.

---

## 2. Login screen → Auth service

Create a UMG widget **`WBP_Login`** with two Text Boxes (`EmailBox`, `PasswordBox`)
and a Button (`LoginButton`). Then, in its Graph:

**On `LoginButton` → OnClicked:**
```
OnClicked
  → Get Game Instance
  → Get Subsystem (class = PhoenixAuthSubsystem)     [store as "Auth"]
  → Bind Event to OnAuthCompleted (target = Auth, event = HandleAuthDone)
  → Auth ▸ Login
        Email    = EmailBox ▸ GetText ▸ ToString
        Password = PasswordBox ▸ GetText ▸ ToString
```

**Custom Event `HandleAuthDone(bool bSuccess, String Message)`:**
```
HandleAuthDone
  → Branch (Condition = bSuccess)
       True  → Open Level (by name = "L_Lobby")
       False → Set Text on a StatusLabel = Message
```

That's the whole login flow — the C++ subsystem does the HTTP POST to
`/auth/login`, parses the JSON, stores the JWT, and fires `OnAuthCompleted`.

---

## 3. Authed calls to other services (pattern)

For any later call (profile, inventory, store), read the token from the same
subsystem and attach it:

```
Get Subsystem (PhoenixAuthSubsystem)
  → Get Access Token            → make header "Authorization: Bearer <token>"
  → Get User Id                 → path/param for the request
```

(A `PhoenixApiSubsystem` that wraps these GET/POSTs with the bearer header is the
next C++ file — ask and I'll write it the same way as the Auth subsystem.)

---

## Troubleshooting

- **Login always fails / "Network error"** → is `make -C phoenix up` running, and
  is the Auth service reachable at `http://127.0.0.1:4001/health`? On a phone use
  your PC's LAN IP via `SetBaseUrl`.
- **`F` does nothing** → the target must be a **Pawn** with collision on the
  `Pawn` channel within `InteractReach` (220 cm). Check the trace channel.
- Send me a screenshot of any red node or compile error and I'll tell you the fix.
