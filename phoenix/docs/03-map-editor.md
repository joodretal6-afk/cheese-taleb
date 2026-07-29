# 03 — Web Map Editor

> **Module 2** of the build roadmap. Lives in `phoenix/editor/`.
> A browser-based tool where a level designer paints an ~8×8 km Battle Royale map
> (terrain, water, roads, biomes, props, spawns, loot) and exports it to a
> versioned, engine-agnostic **map file** that the Unreal Engine 5.6 client imports.

- **Status:** design (this doc) → build (see [Milestones](#10-milestones)).
- **Owner:** Tools Engineering.
- **Consumers:** Level Design (authoring), UE5 client (import), Backend (map
  registry + match config), Admin Dashboard (map versioning/publishing).

---

## 1. Goals & non-goals

**Goals**

- One designer can lay out a full BR island (terrain, biomes, water, roads,
  buildings, loot, spawns, gas-circle tuning) in the browser with no local install.
- Deterministic, reviewable, diff-able output: the map is **data**, committed to
  git and published through the Admin Dashboard.
- A clean import path into UE5 that a technical artist can run in one click — no
  hand-placing thousands of actors.
- Runs smoothly on a mid-range laptop at an 8×8 km scale.

**Non-goals**

- Not a UE5 replacement. Final lighting, materials, nanite meshes, gameplay
  volumes, and collision authoring happen in Unreal. The editor produces
  **layout + heightfield + placement intent**, not final art.
- Not a physics/gameplay simulator. Gas-circle preview is a visualization only.
- Not multi-user real-time co-editing in v1 (see [Milestones](#10-milestones) —
  it's a later add-on; v1 is single-author with git-based merge).

---

## 2. Why web

| Reason | Detail |
| --- | --- |
| **Zero install** | Designers, producers, and QA open a URL. No Unreal license or 150 GB checkout to *look at* or tweak a map. |
| **Reviewable** | Runs next to the Admin Dashboard; map versions are links you can send, preview, and comment on. |
| **Fast iteration** | Hot-reload TS, no 20-minute UE5 cook to move a spawn point. Paint → save → the UE5 import re-runs. |
| **Cross-platform** | Windows/macOS/Linux/Chromebook, all identical. |
| **Cheap CI** | The map file is JSON + a PNG. Validate it, lint it, snapshot-test it in normal web CI. |

The cost we accept: the browser is not Unreal, so the editor is a *previsualization
+ authoring* surface. We bridge the fidelity gap with a solid export pipeline
(Section 8), not by trying to render final-quality art in WebGL.

---

## 3. Tech stack

### 3.1 Recommendation: React + **Babylon.js**

We use **React** for all UI (panels, tool palettes, inspectors, asset browser,
modals) and a dedicated web 3D engine for the viewport. The two are bridged by a
thin store (see 3.3) — React never touches the render loop directly.

**3D engine: Babylon.js** (over Three.js and raw WebGPU).

| Criterion | Babylon.js | Three.js | Verdict |
| --- | --- | --- | --- |
| Large-terrain tooling | Built-in `TerrainMaterial`, `DynamicTerrain` (LOD terrain that streams around a moving camera), CDLOD-friendly | You build heightfield LOD yourself | **Babylon** — big head start for an 8 km map |
| Engine-as-framework | Batteries included: gizmos, picking, `SceneOptimizer`, `AssetContainer`, thin instances, inspector | Minimal core, assemble everything from libs | **Babylon** for a tool of this scope |
| WebGPU | First-class `WebGPUEngine`, transparent WebGL2 fallback | WebGPU renderer maturing | **Babylon** — compute shaders for brushes |
| Instancing at scale | `ThinInstances` (tens of thousands of props in one draw call) | `InstancedMesh` (comparable) | Tie |
| Ecosystem / hiring | Smaller than Three | Larger community, more examples | **Three** |
| Bundle size | Heavier (tree-shakeable via ES6 packages) | Lighter | **Three** |

**Why Babylon wins for *this* tool:** an 8×8 km streamed-LOD terrain editor with
gizmos, picking, thousands of instanced props, and GPU brush strokes is exactly
the "engine, not library" case. Babylon ships most of that infrastructure
(`DynamicTerrain`, thin instances, built-in gizmo manager, `SceneOptimizer`,
WebGPU compute) so we spend our time on *editor logic*, not on rebuilding a small
engine. Three.js is the right call for a lightweight bespoke renderer; here the
scope favors the batteries-included engine.

> **If the team already has deep Three.js muscle**, Three + `three-mesh-bvh` (fast
> raycasts for brushes) + a custom CDLOD terrain is a viable alternative. The rest
> of this document — data format, export pipeline, chunking model — is engine-agnostic
> and unchanged either way.

### 3.2 Full stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Language | **TypeScript** (strict) | Shared map-format types live in `phoenix/packages/map-format` and are imported by editor, backend, and the export CLI. |
| UI framework | **React 18** + Vite | Same toolchain as the Admin Dashboard. |
| 3D viewport | **Babylon.js** (WebGPU → WebGL2 fallback) | Single `<canvas>`, one `Engine`/`Scene`. |
| State | **Zustand** + **Immer** | Document store + undo/redo (see 3.3). |
| Command/undo | Custom command stack | Every edit is a serializable command → undo/redo, and the basis for later multiplayer. |
| Persistence | Autosave to IndexedDB; canonical save to backend Map service (S3-backed) | Local cache survives refresh; server is source of truth. |
| Heightmap storage | 16-bit PNG (portable) or R16 RAW | See [Section 6](#6-heightmap). |
| Workers | Web Workers + OffscreenCanvas | Heightmap ops, tile meshing, import/export off the main thread. |
| Validation | **Zod** schema mirrored from the TS types | One schema validates in editor, in CI, and server-side on upload. |
| Testing | Vitest (logic) + Playwright (viewport smoke) | Snapshot the exported JSON. |

### 3.3 Architecture — React ⟷ engine bridge

```
                    ┌────────────────────────────────────────┐
                    │              React UI shell              │
                    │  toolbars · inspector · asset browser ·  │
                    │  layer list · minimap · spawn tables     │
                    └───────────────┬──────────────────────────┘
                                    │  read state / dispatch commands
                            ┌───────▼────────┐
                            │  Document Store │  (Zustand + Immer)
                            │  = the map data │  ── serialized 1:1 to the map file
                            │  + command stack│
                            └───────┬────────┘
                     subscribe      │      dispatch(cmd)
                            ┌───────▼────────┐
                            │  Editor Engine  │  (plain TS, no React)
                            │  Babylon Scene  │
                            │  ┌───────────┐  │
                            │  │ Terrain   │  │  streamed LOD tiles
                            │  │ Water     │  │
                            │  │ Splines   │  │  roads/rivers/bridges
                            │  │ Instances │  │  thin-instanced props
                            │  │ Markers   │  │  spawns/loot/vehicles
                            │  │ Overlays  │  │  biome splat, gas circle
                            │  │ Brushes   │  │  GPU brush compute
                            │  │ Gizmos    │  │  move/rotate/scale
                            │  └───────────┘  │
                            └─────────────────┘
```

- **The Document Store *is* the map.** Its serialized shape equals the map file
  (Section 5). "Save" = serialize store; "Load" = hydrate store.
- **React is presentation + dispatch only.** It renders panels from store state and
  dispatches commands. It never mutates the scene.
- **The engine subscribes** to store changes and reconciles the Babylon scene
  (add/remove/update objects). Heavy per-pixel data (the live heightmap being
  painted) lives engine-side in typed arrays / GPU textures; the store holds a
  reference + dirty rects, not 130 MB of floats, so undo stays cheap.
- **Everything is a command.** `RaiseTerrain(region, delta)`, `PlaceObject(...)`,
  `MoveObject(id, transform)`. Commands are serializable → undo/redo today,
  operational-transform multiplayer later.

---

## 4. Editing features

The viewport is a top-down-ish free camera over the terrain. Tools are modal
(one active brush/placement mode), chosen from a left palette; the right panel is
a context inspector for the current tool or selection. A layer list (like an image
editor) controls visibility/lock per layer.

### 4.1 Terrain — heightmap sculpting

Height is a single-channel heightfield at a fixed resolution (default **2049×2049**
for 8 km ≈ ~3.9 m/texel; configurable). Brushes are **GPU compute passes** (WebGPU)
with a WebGL2 fragment-shader fallback, writing into an R32F height texture; the CPU
copy is synced lazily for save/export.

| Brush | Behavior | Key params |
| --- | --- | --- |
| **Raise / Lower** | Add/subtract falloff-weighted height under the cursor | radius, strength, falloff curve, ± |
| **Smooth** | Blur toward local neighborhood average | radius, strength |
| **Flatten** | Pull toward a target height (sampled on click, or typed) | radius, target height, tolerance |
| **Set / Stamp** | Paint an absolute height, or stamp a heightmap texture (mesa, crater, hill) | height, stamp asset, rotation, scale |
| **Noise** | Add fractal detail (ridged/billow/fBm) | frequency, octaves, amplitude |
| **Erosion** (later) | Hydraulic/thermal erosion pass over a region | iterations, rain, sediment |

- **Brush stroke model:** on drag, stamp the brush along the pointer path at a fixed
  world-space spacing (so speed doesn't change density). Each *completed stroke* is
  ONE undo command that stores the affected rect's before/after (compressed), not
  every mouse-move.
- **Precision tools:** ramp tool (drag A→B for a graded slope), plateau, and
  numeric height entry for exact values (helipads, road grades).

### 4.2 Terrain texture / biome painting

A **splat/weight system**: N material layers (e.g. `grass`, `dirt`, `rock`,
`sand`, `snow`, `mud`), stored as weight channels in **splatmaps** (RGBA texture =
4 layers each; two textures → 8 layers). Painting writes weights with a brush;
weights are normalized per texel.

- **Biomes** are named presets that bundle a dominant material + prop-scatter rules
  + optional post/fog tint (e.g. `Coastal`, `Forest`, `Urban`, `Desert`,
  `Highlands`). Painting a biome paints its splat weight **and** tags the region so
  the prop scatterer and UE5 PCG know what to grow there.
- **Auto-rules** (optional): "rock above slope 40°", "sand below height 3 m near
  water" — evaluated as a preview layer the designer can bake or override.
- Splatmaps and biome region masks are exported alongside the heightmap
  (Section 8), so UE5 gets the same layer weights and PCG biome tags.

### 4.3 Water bodies (sea / river / lake)

Water is authored as typed **water volumes**, not painted into the heightfield:

| Type | Authoring | Data |
| --- | --- | --- |
| **Sea** | Global water plane at a world sea level | single `seaLevel` height |
| **Lake** | Draw a closed polygon; assign a surface height | polygon + `surfaceHeight` |
| **River** | Draw a spline centerline; width profile along it; source/mouth heights → flows downhill | spline + width profile + start/end height |

- **Preview:** a translucent animated water shader at each volume's surface height;
  terrain below the surface reads as underwater. A "carve river bed" helper can
  lower the heightfield under a river spline to guarantee it sits in a channel.
- **Shoreline validation:** the editor flags water surfaces that sit *above*
  adjacent terrain (would flood) so designers catch leaks before export.
- Exported as `water[]` volumes; UE5 spawns Water Body Ocean/Lake/River actors
  (UE Water plugin) from them.

### 4.4 Roads & bridges (splines)

- **Roads** are **splines** with a width profile and a road-material id. The mesh
  is generated as a ribbon that conforms to (and can flatten) the terrain beneath
  it. Types: highway / street / dirt / trail.
- **Terrain conform modes:** `drape` (follow ground), `cut-fill` (flatten a
  corridor to the road grade — writes to the heightfield), `embankment`.
- **Bridges** are road spline segments flagged `bridge`, which ignore terrain
  conform and instead ride at spline height on generated pillars — used to cross
  rivers/canyons. Bridge pillar spacing + deck mesh id are params.
- **Intersections:** where road splines cross, mark a junction node (v1: visual
  only; v2: generated junction mesh).
- Export: `splines[]` with `role: road|river|bridge`, control points, width
  profile, material, conform mode → UE5 rebuilds spline meshes / PCG-splines.

### 4.5 Placement — buildings, trees, rocks, props

Placement uses a searchable **Asset Browser** (categories: buildings, foliage,
rocks, cover, decals, gameplay). Each asset is referenced by a stable **`assetId`**
from the asset catalog; the editor loads a lightweight web preview mesh (decimated
glTF), while UE5 resolves `assetId` → the real high-fidelity asset on import.

| Mode | Use |
| --- | --- |
| **Single place** | Click to place one instance; drag to orient; snap to ground/grid; align-to-normal toggle |
| **Scatter brush** | Paint many (trees, rocks, grass) with density/scale/rotation jitter, slope/height/biome masks, min-spacing (Poisson) |
| **Line / array** | Fences, walls, prop rows along a spline or between two points |
| **Cluster/prefab** | Place a saved group (a village, a compound) as one unit; explode to edit |

- Rendered with **thin instances** (per assetId), so tens of thousands of trees are
  a handful of draw calls.
- Every placed object carries `{ id, assetId, type, transform, layer, tags,
  overrides }`. Buildings can carry a `lootProfile` (density class) and named
  interior spawn anchors that loot generation uses.
- **Grid snapping / gizmos:** Babylon gizmo manager for move/rotate/scale;
  configurable snap; multi-select; copy/paste; align/distribute.

### 4.6 Gameplay markers

Purpose-built marker objects, each a typed entity (not just a prop). All live on
dedicated, toggleable layers and are validated on export.

| Marker | Fields | Purpose |
| --- | --- | --- |
| **Spawn point** | id, transform, `team?`, `tags[]` (e.g. `parachute`, `ground`), enabled | Where players/parachutes start |
| **Loot location** | id, transform, `lootTableId`, `tier` (common…legendary), `spawnChance`, quantity | Ground/interior loot nodes; can be auto-generated from building loot anchors |
| **Vehicle spawn** | id, transform, `vehicleClass[]` (weighted), `spawnChance`, respawn | Where cars/bikes/boats spawn |
| **Care package / POI** | id, transform, `poiId`, name, radius | Named points of interest / high-tier drops |
| **Blocking / nav hint** | volume | Out-of-bounds, no-build, nav hints (advisory to UE5) |

- **Spawn tables** (map-level) reference these: a weighted list controlling how many
  of each loot tier / vehicle class the match seeds, referenced by `lootTableId` /
  class ids that resolve against the backend Economy service catalog.
- **Validators:** min number of parachute spawns, no loot inside geometry, vehicle
  spawns reachable, POIs don't overlap — run on save and block export on error.

### 4.7 Safe-zone / gas circle preview

A **visualization + tuning** tool (not a simulation of the live match):

- Overlay concentric shrink circles on the map. Designer edits the **phase table**:
  per phase → `{ waitTime, shrinkTime, radiusFactor, damagePerSec, allowedCenterRegion }`.
- **Play-preview:** scrub a timeline; the editor animates the circle shrinking
  through phases and can Monte-Carlo a few random first-circle placements to show
  coverage (does every phase still contain enough POIs/loot? does it ever collapse
  into water?).
- **Heatmaps:** loot-density and spawn-density overlays to balance the map against
  likely circles.
- Exported in map metadata as the default `zoneConfig`; the match server can
  override per playlist, but the map ships sane defaults.

---

## 5. Map data format

The map is a **directory bundle** (a `.phxmap` — a zip, or a folder in git): a
JSON manifest plus binary assets it references (heightmap, splatmaps, masks,
thumbnail). Large raster data is **never** inlined in JSON — JSON holds references
+ hashes. The TS types + Zod schema are the single source of truth in
`phoenix/packages/map-format`.

### 5.1 Bundle layout

```
my-island.phxmap/
  map.json                 # the manifest (schema below)
  heightmap.r16.png        # 16-bit heightfield
  splat/
    splat_0.png            # layers 0-3 weights (RGBA)
    splat_1.png            # layers 4-7 weights (RGBA)
  masks/
    biome.png              # indexed biome regions
    hole.png               # terrain holes (caves/interiors), optional
  thumb.png                # editor thumbnail
```

### 5.2 Coordinate & unit conventions

- **Units:** meters. World origin at map center, `+X` east, `+Y` up, `+Z` north
  (right-handed). The exporter handles the swap to UE5's left-handed, Z-up,
  centimeter space (Section 8.4).
- **Heightmap mapping:** texel value `0…65535` maps linearly to
  `[heightRange.min, heightRange.max]` meters. Heightmap texel (0,0) = world
  `(-size/2, _, +size/2)` (NW corner).
- **Transforms:** position in meters, rotation as quaternion `[x,y,z,w]`, uniform
  or non-uniform scale.

### 5.3 `map.json` schema (annotated)

```jsonc
{
  "formatVersion": "1.0.0",          // map-format semver; importer checks compat
  "id": "map_savanna_ridge",         // stable map id (registry key)
  "meta": {
    "name": "Savanna Ridge",
    "author": "jdoe",
    "createdAt": "2026-07-20T10:00:00Z",
    "updatedAt": "2026-07-29T14:12:00Z",
    "revision": 42,                  // bumped every save; used by version history
    "description": "8x8 mixed savanna + coastal town",
    "tags": ["br", "8km", "coastal"]
  },

  "world": {
    "sizeMeters": [8192, 8192],      // playable extent (X, Z)
    "heightRange": { "min": -50, "max": 600 },  // maps heightmap 0..65535 -> meters
    "seaLevel": 0.0,
    "tileSize": 512,                 // chunk edge in meters (streaming/export tiles)
    "originMode": "center"           // world origin at map center
  },

  "terrain": {
    "heightmap": {
      "file": "heightmap.r16.png",
      "resolution": [2049, 2049],    // (N*tiles)+1 vertices
      "encoding": "png-r16",         // or "raw-r16"
      "sha256": "9f2c…"              // integrity + cache key
    },
    "materials": [                   // splat layer definitions (index = layer id)
      { "id": "grass", "displayName": "Grass" },
      { "id": "dirt",  "displayName": "Dirt"  },
      { "id": "rock",  "displayName": "Rock"  },
      { "id": "sand",  "displayName": "Sand"  }
    ],
    "splatmaps": [
      { "file": "splat/splat_0.png", "layers": ["grass","dirt","rock","sand"],
        "resolution": [2048, 2048], "sha256": "a1b2…" }
    ],
    "holes": { "file": "masks/hole.png", "sha256": null }  // optional
  },

  "biomes": {
    "mask": { "file": "masks/biome.png", "sha256": "c3d4…" },
    "table": [                       // index in mask -> biome def
      { "index": 0, "id": "grassland", "name": "Grassland",
        "scatter": ["scatter_savanna_trees", "scatter_bushes"] },
      { "index": 1, "id": "coastal", "name": "Coastal Town",
        "scatter": [] }
    ]
  },

  "water": [
    { "id": "sea",   "type": "sea",  "surfaceHeight": 0.0 },
    { "id": "lake_1","type": "lake", "surfaceHeight": 12.5,
      "polygon": [[120,340],[180,360],[210,300], /* … x,z meters */ ] },
    { "id": "river_1","type": "river","surfaceHeightStart": 80, "surfaceHeightEnd": 4,
      "spline": "spline_river_1", "widthProfile": [[0,6],[0.5,14],[1,22]],
      "carveDepth": 3.0 }
  ],

  "splines": [
    { "id": "spline_hwy_1", "role": "road", "roadType": "highway",
      "materialId": "road_asphalt", "conform": "cut-fill",
      "widthProfile": [[0,12],[1,12]],
      "points": [                    // control points; tangents optional (auto-catmull)
        { "p": [-1200, 4, 300], "t_in": null, "t_out": null },
        { "p": [-400, 10, 280] },
        { "p": [350, 22, 260] }
      ],
      "segments": [ { "from": 1, "to": 2, "flags": ["bridge"],
                     "bridge": { "deckId": "bridge_deck_a", "pillarSpacing": 24 } } ]
    },
    { "id": "spline_river_1", "role": "river",
      "points": [ { "p": [900, 80, -1200] }, { "p": [400, 30, -300] }, { "p": [120, 4, 500] } ] }
  ],

  "objects": [                       // every placed prop/building/rock
    { "id": "obj_000a1", "assetId": "bld_house_small_01", "type": "building",
      "transform": { "pos": [412.0, 10.2, -88.5],
                     "rot": [0,0.383,0,0.924], "scale": [1,1,1] },
      "layer": "buildings", "tags": ["town"],
      "lootProfile": "residential",
      "interiorSpawns": [ { "id": "is_1", "local": [0,1,2], "lootTableId": "lt_indoor_common" } ],
      "overrides": {}                // per-instance material/variant overrides
    },
    { "id": "obj_000b2", "assetId": "tree_acacia_02", "type": "foliage",
      "transform": { "pos": [510.3, 6.1, 44.0], "rot": [0,0.2,0,0.98], "scale": [1.2,1.2,1.2] },
      "layer": "foliage", "scatterGroup": "scatter_savanna_trees" }
  ],

  "markers": {
    "spawns": [
      { "id": "sp_1", "pos": [0, 400, 0], "tags": ["parachute"], "enabled": true }
    ],
    "loot": [
      { "id": "loot_1", "pos": [412, 11, -88], "lootTableId": "lt_indoor_common",
        "tier": "common", "spawnChance": 0.8, "quantity": 1 }
    ],
    "vehicles": [
      { "id": "veh_1", "pos": [430, 10, -60],
        "classes": [ { "class": "car_offroad", "weight": 3 }, { "class": "bike", "weight": 1 } ],
        "spawnChance": 0.6 }
    ],
    "pois": [
      { "id": "poi_town", "name": "Harbor Town", "pos": [400, 10, -80], "radius": 300 }
    ]
  },

  "spawnTables": {                   // map-level seeding config (ids resolve vs Economy catalog)
    "loot": [
      { "id": "lt_indoor_common", "entries": [
        { "itemPool": "pool_ammo", "weight": 5 },
        { "itemPool": "pool_meds", "weight": 3 },
        { "itemPool": "pool_weapon_smg", "weight": 1 } ] }
    ],
    "vehicles": [
      { "class": "car_offroad", "maxAlive": 40 },
      { "class": "boat", "maxAlive": 15 }
    ]
  },

  "zoneConfig": {                    // gas-circle defaults
    "firstCircleRegion": { "center": [0,0], "radius": 3000 },
    "phases": [
      { "phase": 1, "waitTime": 90, "shrinkTime": 120, "radiusFactor": 0.60, "dps": 1 },
      { "phase": 2, "waitTime": 60, "shrinkTime": 100, "radiusFactor": 0.55, "dps": 2 },
      { "phase": 3, "waitTime": 45, "shrinkTime": 80,  "radiusFactor": 0.50, "dps": 5 }
    ]
  },

  "export": {                        // last export bookkeeping (informational)
    "ue5": { "landscapeScale": [400, 400, 128], "componentSize": 63, "sectionsPerComponent": 2 }
  }
}
```

### 5.4 Design rules for the format

- **Engine-agnostic core.** Nothing above is UE5-specific except the optional
  `export.ue5` hint block. The same file could drive a Unity or bespoke importer.
- **References, not blobs.** Rasters are external files with `sha256` for integrity
  + caching. JSON diffs stay small and human-reviewable in PRs.
- **Stable ids everywhere.** `assetId`, object `id`, `lootTableId` are stable so
  UE5 placement, backend match config, and analytics all agree on the same keys.
- **Versioned.** `formatVersion` is semver; the importer and a migration layer
  handle upgrades. Breaking changes bump major.
- **IDs resolve outward.** `assetId` → asset catalog; `lootTableId` / vehicle
  `class` / `itemPool` → Economy service catalog. The map references, it doesn't
  embed game balance.

---

## 6. Heightmap {#6-heightmap}

- **Authoring precision:** float32 in-engine (R32F GPU texture) while painting.
- **Stored/exported precision:** **16-bit unsigned** — the format UE5 Landscape
  import expects. 16 bits over a 650 m range ≈ 1 cm vertical resolution, plenty.
- **Container:** **16-bit grayscale PNG** by default (portable, compressed,
  git-friendly, browser-encodable via a small worker) — or **`.r16` RAW**
  (headerless little-endian uint16) for a direct UE5 RAW import with zero
  transcoding.
- **Resolution rule:** UE5 landscapes want `componentSize * sections + 1` vertices.
  We default to **2049×2049** (= 32 tiles of 64 + 1), which lines up cleanly with
  a 63-quad component layout. Editor enforces valid resolutions.
- **Value mapping:** `worldHeight = min + (texel / 65535) * (max - min)`, with
  `heightRange` carried in `world.heightRange`.

---

## 7. Performance for an 8×8 km browser map {#7-performance}

The whole map never lives at full detail on screen. Strategy = **tile + LOD +
stream**, everything heavy off the main thread.

### 7.1 Terrain

- **Chunked tiles:** the terrain is a grid of tiles (default `tileSize` 512 m → a
  16×16 tile grid for 8 km). Each tile is an independent mesh built in a worker
  from its slice of the heightmap.
- **LOD / CDLOD:** each tile has multiple index-buffer LODs; the mesh shader (or
  CPU selection) picks LOD by camera distance, with **skirts / geomorphing** to
  hide seams. Babylon's `DynamicTerrain` gives a camera-following LOD terrain out of
  the box; for full-map authoring we wrap it with our own tile manager so distant
  tiles drop to coarse LOD (or an imposter) rather than unloading (designers need to
  see the whole island).
- **Frustum + distance culling:** only build/upload tiles in view or near camera;
  far tiles use a low-res "overview" mesh so the silhouette is always present.
- **GPU brushes:** editing writes to the height texture on the GPU; only the
  touched tiles re-mesh, and only their dirty rects re-upload.

### 7.2 Objects / foliage

- **Thin instances per `assetId`:** all trees of a type = one draw call. An 8 km map
  can hold hundreds of thousands of foliage instances this way.
- **Spatial index (quadtree/grid):** instances bucketed per tile; only visible-tile
  buckets are uploaded. Picking uses the quadtree (or a BVH) — never a linear scan.
- **Instance LOD + fade:** distant props swap to billboards/imposters or cull by a
  per-type distance; grass/small clutter has a tight draw distance.
- **Decimated web preview meshes:** the editor loads lightweight glTF proxies, not
  the UE5-fidelity assets. Real geometry only exists in Unreal.

### 7.3 Textures & memory

- **Streamed splatmaps** per region; virtual-texture-ish paging so we don't hold all
  splat/biome rasters at full res at once.
- **KTX2 / Basis** compressed textures for previews (GPU-friendly, small).
- **Budgets** surfaced in a debug HUD: draw calls, triangles, instance count,
  texture MB, tiles resident. `SceneOptimizer` auto-degrades (shadows, distance) if
  FPS drops.

### 7.4 Threading

- Web Workers (+ OffscreenCanvas / transferable `ArrayBuffer`s) for: tile meshing,
  heightmap PNG encode/decode, erosion, scatter generation, and export packaging.
  The main thread stays for render + input.

### 7.5 Budget targets (mid-range laptop)

| Metric | Target |
| --- | --- |
| Frame rate (authoring) | ≥ 60 fps navigating; ≥ 30 fps mid brush-stroke |
| Draw calls | < ~2,000 typical view |
| Resident tiles | view frustum + 1-ring, rest at overview LOD |
| Brush latency | < 16 ms per stamp (GPU path) |
| Cold load of a full map | < ~8 s (stream in, don't block on all tiles) |

---

## 8. Export to UE5 {#8-export}

Two artifacts leave the editor: (1) the **`.phxmap` bundle** (Section 5), and (2)
UE5-ready inputs derived from it. Import is a one-click **Unreal Editor Utility**
that reads the bundle and builds the level. Nothing is hand-placed.

### 8.1 Pipeline overview

```
  Editor "Export"                Bundle (git / Map service)              UE5 Editor
 ┌──────────────┐   validate    ┌───────────────────────┐   pull     ┌───────────────────────┐
 │ Document store│──────────────▶│ my-island.phxmap      │───────────▶│ PhoenixMapImporter     │
 │  = map.json   │   + package   │  map.json             │            │ (Editor Utility, C++/  │
 │  + rasters    │               │  heightmap.r16.png    │            │  Python/Blueprint)     │
 └──────────────┘               │  splat/*, masks/*      │            └───────────┬───────────┘
        │                        └───────────────────────┘                        │
        │ Zod validate + UE hints                                                  ▼
        │ (landscape scale, component size)                       ┌──────────────────────────────┐
        ▼                                                         │ 1. Import Landscape (heightmap)│
   report errors                                                  │ 2. Apply landscape layers      │
   (block on fail)                                                │    (splatmaps -> paint layers) │
                                                                  │ 3. Spawn actors from objects[] │
                                                                  │    (data-driven spawner)       │
                                                                  │ 4. Build splines (roads/rivers │
                                                                  │    /bridges) + PCG splines     │
                                                                  │ 5. PCG scatter per biome mask  │
                                                                  │ 6. Water Body actors           │
                                                                  │ 7. Gameplay markers ->         │
                                                                  │    spawn/loot/vehicle actors   │
                                                                  │ 8. Write DataAsset (zone, tables)│
                                                                  └──────────────────────────────┘
```

### 8.2 Landscape import

- The importer creates a **UE5 Landscape** from `heightmap.r16.png` (or `.r16`
  RAW). It sets **Landscape Scale** from `world.heightRange` + `sizeMeters` so the
  imported terrain matches the authored meters exactly:
  - `ScaleXY = sizeMeters.x / (resolution.x - 1) * 100` (cm) — quads to cm.
  - `ScaleZ` chosen so full 16-bit range = `(max - min)` meters (UE's default is
    512 m over the 16-bit range at Z-scale 100; the importer computes the exact
    Z-scale and Z-offset for our `heightRange`).
  - Component/section layout taken from `export.ue5` hints (e.g. component size
    63, 2 sections) — which is why the editor enforces `N*tiles+1` resolutions.
- **Splatmaps → Landscape paint layers:** each splat channel is imported as the
  weight for the matching Landscape Layer (materials created once in a template
  landscape material; layer names match `terrain.materials[].id`).

### 8.3 Data-driven actor placement

- The importer iterates `objects[]`. Each `assetId` is looked up in a **UE
  DataTable / asset registry** (`assetId → soft object path` to the real
  StaticMesh/Blueprint). It spawns the actor (or adds to an ISM/HISM component per
  `assetId` for foliage — matching the editor's instancing), applies the transform
  (after coordinate conversion, 8.4), and applies `overrides`.
- **Buildings** with `lootProfile` / `interiorSpawns` spawn as gameplay Blueprints
  carrying that data so runtime loot generation can use interior anchors.
- **Markers** become gameplay actors: `PhoenixPlayerSpawn`, `PhoenixLootSpawner`
  (holds `lootTableId`, tier, chance), `PhoenixVehicleSpawner` (weighted classes),
  `PhoenixPOI`. These are the actors the dedicated server queries at match start.
- **Splines** rebuild as UE **Spline Components**: roads via spline mesh (or PCG
  spline) with the road material; `bridge` segments spawn deck + pillar meshes;
  rivers feed the water river spline. `conform: cut-fill` corridors were already
  baked into the heightmap by the editor, so the terrain arrives pre-graded.

### 8.4 Coordinate conversion

The importer converts every transform from the editor's convention to Unreal's:

| | Editor | UE5 |
| --- | --- | --- |
| Handedness | right-handed | left-handed |
| Up axis | +Y | +Z |
| Units | meters | centimeters |

Position `(x, y, z) m → (x*100, z*100, y*100) cm` (Y↔Z swap + m→cm), with a matching
quaternion basis change. This mapping is centralized in one importer function and
unit-tested against known reference points so the whole map lands correctly.

### 8.5 PCG (Procedural Content Generation)

For dense natural cover we don't ship every tree as an explicit object. Instead:

- The editor's **scatter groups** + **biome mask** export as PCG inputs. The
  importer feeds the biome mask and per-biome scatter rules into a **PCG graph**,
  which procedurally populates foliage per biome at import (or at runtime via
  runtime-generation), constrained by slope/height/water/road exclusion.
- **Hand-placed** hero objects (buildings, named landmarks, specific cover) stay as
  explicit `objects[]` and are spawned exactly. PCG only fills the "nature carpet."
- This keeps the map file small (rules, not millions of transforms) while giving
  UE5 the density it needs.

### 8.6 The UE5-side importer (high level)

- Ships as a **UE Editor Utility Widget** (button: "Import Phoenix Map…") backed by
  C++ (`UPhoenixMapImporter`) with Blueprint/Python glue.
- Steps, idempotent and re-runnable into a **dedicated sublevel** (so re-import
  replaces generated content without nuking hand-tweaks in other sublevels):
  1. Validate `formatVersion` compatibility; parse `map.json`.
  2. Import/replace Landscape from heightmap; set scale/offset; import weight layers.
  3. Spawn `objects[]` via the `assetId` DataTable (ISM/HISM for instanced types).
  4. Build spline actors (roads/bridges/rivers).
  5. Run PCG population from biome mask + scatter groups.
  6. Spawn Water Body actors from `water[]`.
  7. Spawn gameplay marker actors from `markers`.
  8. Write a **`UPhoenixMapDataAsset`** (zoneConfig, spawnTables, POIs, map meta)
     that the game mode + dedicated server load at runtime.
  9. Emit an import report (counts, unresolved `assetId`s, warnings).
- Backend can also run a **headless commandlet** version in CI to validate that a
  published map imports cleanly, without opening the editor GUI.

---

## 9. Interop with the rest of Phoenix

| System | Relationship |
| --- | --- |
| `packages/map-format` | TS types + Zod schema shared by editor, backend, export CLI. |
| **Map/registry service** (backend) | Stores `.phxmap` versions (S3), lists them, serves to editor + Admin, gates publish. |
| **Admin Dashboard** | Browse maps, view versions/thumbnails, promote a revision to "published". |
| **Economy service** | Source of truth for `itemPool` / vehicle `class` / loot ids the map references. |
| **Asset catalog** | `assetId → web preview (glTF)` for editor, `assetId → UE soft path` for import. |
| **Dedicated server** | Loads the imported `UPhoenixMapDataAsset` (spawns, loot, vehicles, zoneConfig) at match start. |

---

## 10. Milestones {#10-milestones}

Built in dependency order; each milestone is independently demoable and testable.

| # | Milestone | Delivers | Done = |
| --- | --- | --- | --- |
| **M0** | **Shell & format** | React app scaffold in `phoenix/editor/`; `packages/map-format` (TS types + Zod); load/save empty `.phxmap` to backend + IndexedDB | Round-trips an empty map file; schema validates in CI |
| **M1** | **Terrain viewport** | Babylon scene, camera controls, chunked LOD terrain from a heightmap, debug HUD | Loads a 2049² heightmap at 8 km and navigates ≥60 fps |
| **M2** | **Sculpting** | GPU raise/lower/smooth/flatten/set brushes; stroke-based undo/redo; 16-bit PNG/R16 encode-decode | Paint terrain, undo, save, reload identical |
| **M3** | **Biome & splat paint** | Splatmap layers, biome mask painting, material preview, slope/height auto-rules | Paint layers; splatmaps export & round-trip |
| **M4** | **Water** | Sea plane, lake polygons, river splines, carve-bed helper, shoreline validator | Author all 3 water types; preview + export |
| **M5** | **Splines** | Roads (drape/cut-fill), bridges, width profiles, terrain conform | Author a road + bridge crossing a river |
| **M6** | **Placement** | Asset browser, single/scatter/line/cluster placement, thin instances, gizmos, quadtree picking | Place 100k+ instances, edit, save |
| **M7** | **Markers & tables** | Spawn/loot/vehicle/POI markers, spawn tables, validators | Author + validate; export markers |
| **M8** | **Zone preview** | Gas-circle phase editor, play-preview scrub, density heatmaps | Tune phases; export `zoneConfig` |
| **M9** | **UE5 importer** | `UPhoenixMapImporter` editor utility: landscape, layers, actors, splines, PCG, water, markers, DataAsset | Import a full `.phxmap` into UE5 → playable layout |
| **M10** | **Polish & scale** | Perf pass (streaming/imposters/SceneOptimizer), autosave, version history in Admin, headless import CI | 8 km map authored end-to-end at target budgets |
| **M11** | **(later) Collaboration** | Command-log OT/CRDT multi-user editing, presence, comments | Two designers edit one map live |

**Critical path to first playable map:** M0 → M1 → M2 → M9 (terrain-only import
proves the pipeline early), then fill in M3–M8, then M10.
