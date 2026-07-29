# Phoenix Map Editor

Web-based map editor for Project Phoenix. Sculpt a battle-royale terrain in the
browser and save it as a `.phxmap` document that the UE5 client imports.

## Run

```bash
cd phoenix/editor
npm install
npm run dev      # http://127.0.0.1:5273
```

## Controls

- **Left-drag** — sculpt with the active brush
- **Right-drag** — orbit · **Middle-drag** — pan · **Wheel** — zoom

## Status (M0–M1 done)

- ✅ React + Babylon.js shell, orbit/pan/zoom camera
- ✅ Editable heightfield terrain with live elevation colour ramp
- ✅ Sculpt brushes: raise / lower / smooth / flatten (size + strength)
- ✅ Save / load the `.phxmap` document (`src/map/phxmap.ts`)
- ⏭ Next: water volumes, texture/biome painting, object & spawn placement,
  16-bit heightmap export, UE5 importer

## Verify headlessly

```bash
node scripts/shot.mjs --out scratch/editor.png
```
