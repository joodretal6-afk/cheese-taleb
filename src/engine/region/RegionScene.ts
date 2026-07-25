import {
  Color3,
  Mesh,
  MultiMaterial,
  PBRMaterial,
  SubMesh,
  Texture,
  VertexData,
  type AbstractMesh,
  type Scene,
} from '@babylonjs/core'
import { RegionHeightField } from './RegionHeightField'
import { buildRoadGeometry, DEFAULT_ROAD_MESH } from './roadMesh'
import { inferPlots, DEFAULT_PLOTS } from './plots'
import { buildBuildingGeometry, buildingsFromPlots, type GeneratedBuilding } from './buildingMesh'
import { DEFAULT_PALETTE, roadClassToKey, type Palette, type SurfaceKey, type SurfaceStyle } from './palette'
import { describeRegion, type RegionStats } from './loadRegion'
import {
  roadLength,
  type RegionBuilding,
  type RegionData,
  type RegionPoint,
  type RegionRoad,
  type RoadClass,
} from './types'

/**
 * The baked region, assembled into Babylon meshes.
 *
 * Draw calls are the whole game here. 155 centrelines and several thousand
 * generated houses become at most EIGHT draw calls and never more:
 *
 *   roads     — one mesh, one SubMesh per surface key (≤ 4: major, residential,
 *               service, path). Khalidiya uses 3.
 *   buildings — one mesh for every generated house, 2 SubMeshes (wall, roof).
 *   mapped    — one mesh for the OSM footprints, sharing those same 2 materials.
 *
 * Seven in Khalidiya. The per-house colour variation rides in the vertex colour
 * buffer rather than in materials, which is what lets thousands of buildings in
 * six limestone shades share one material each for wall and roof.
 *
 * The Babylon-facing half of the region pipeline. Everything geometric it calls
 * — the height field, the ribbons, the plots, the extrusions — is a pure
 * function over plain data living in its own module and testable in bare Node.
 */

/** How far apart spawn candidates are sampled along a street, metres. */
const SPAWN_STEP_M = 20
/** Candidates this close to either end of a street are skipped: junctions. */
const SPAWN_EDGE_M = 15
/** Fraction of the carriageway half-width the spawn sits off the centreline. */
const SPAWN_OFFSET = 0.55
/** Half-side of the flatness probe around a spawn candidate, metres. */
const SPAWN_PROBE_M = 2.5
/** Weight on "how far out toward the region edge is this?" in the spawn score. */
const SPAWN_EDGE_PENALTY = 0.06

/** Streets a vehicle can plausibly be parked on. Residential is preferred. */
const SPAWNABLE: RoadClass[] = ['residential', 'living_street', 'unclassified', 'tertiary', 'service']

/**
 * Ceiling on a normalised vertex colour factor.
 *
 * Building colours are divided by the DEFAULT palette entry so the shipped
 * palette reproduces buildingMesh's intent exactly and any other colour shifts
 * the whole neighbourhood while keeping its per-house variety. A house brighter
 * than the reference gives a factor above 1, and this stops a pale palette
 * colour from being multiplied into an over-bright albedo.
 */
const MAX_COLOUR_FACTOR = 1.25

/** Two clipped points closer than this are the same point. */
const EPS = 1e-4

export interface RegionSceneOptions {
  generateBuildings: boolean
  palette: Palette
  onProgress?: (stage: string, fraction: number) => void
}

/** One PBR material plus what applyPalette needs to re-dress it in place. */
interface SurfaceMaterial {
  key: SurfaceKey
  mat: PBRMaterial
  /** Metres of world covered by one unit of UV on the meshes this dresses. */
  uvMetres: number
  textureUrl: string | null
  texture: Texture | null
}

export class RegionScene {
  readonly heightField: RegionHeightField
  readonly stats: RegionStats
  readonly roadMesh: Mesh | null
  readonly buildingMesh: Mesh | null
  readonly mappedBuildingMesh: Mesh | null
  /**
   * Every footprint standing in the region, generated and mapped alike.
   *
   * Kept because the geometry alone cannot answer "where are the walls?" — the
   * meshes are merged, so a house is not separable from its neighbours once
   * built. Physics needs the footprints to make the buildings solid, and the
   * on-foot character needs them to walk around rather than through.
   */
  readonly buildings: GeneratedBuilding[]

  private readonly scene: Scene
  private readonly surfaces: SurfaceMaterial[]
  private readonly multis: MultiMaterial[]
  /** Roads already clipped to the region square; findSpawn walks these. */
  private readonly roads: RegionRoad[]

  private constructor(parts: {
    scene: Scene
    heightField: RegionHeightField
    stats: RegionStats
    roads: RegionRoad[]
    roadMesh: Mesh | null
    buildingMesh: Mesh | null
    mappedBuildingMesh: Mesh | null
    buildings: GeneratedBuilding[]
    surfaces: SurfaceMaterial[]
    multis: MultiMaterial[]
  }) {
    this.scene = parts.scene
    this.heightField = parts.heightField
    this.stats = parts.stats
    this.roads = parts.roads
    this.roadMesh = parts.roadMesh
    this.buildingMesh = parts.buildingMesh
    this.mappedBuildingMesh = parts.mappedBuildingMesh
    this.buildings = parts.buildings
    this.surfaces = parts.surfaces
    this.multis = parts.multis
  }

  /**
   * Assemble the whole region.
   *
   * Order is not negotiable: the height field must exist before the roads can
   * be graded into it, the grading must finish before any ribbon samples a
   * height, and the plots must be judged against the graded surface rather than
   * the raw satellite hill — a street cut into a 25 % slope leaves buildable
   * ground either side of it that the bare terrain says is unbuildable.
   *
   * Each stage yields to the event loop afterwards. Grading 87.8 km of road and
   * extruding several thousand houses is on the order of a second of solid
   * JavaScript, and without the yields the tab is frozen for all of it — no
   * progress bar, no repaint, and on a slow machine a browser "page unresponsive"
   * prompt in the middle of loading.
   */
  static async build(
    scene: Scene,
    region: RegionData,
    options: RegionSceneOptions,
  ): Promise<RegionScene> {
    const report = options.onProgress ?? (() => {})
    const half = region.sizeM * 0.5

    report('قراءة بيانات الارتفاع', 0)
    const heightField = new RegionHeightField(region)
    await yieldToBrowser()

    report('تسوية الطرق في التضاريس', 0.06)
    // Grading takes the UNCLIPPED ways on purpose. Only in-grid cells are ever
    // written, and a road that leaves the square carries its levelled profile
    // out through the boundary instead of stopping dead at the edge.
    heightField.flattenRoads(region.roads)
    await yieldToBrowser()

    // Everything downstream takes the clipped set. The baker does not cut OSM
    // ways at the bbox, so khalidiya.json holds centrelines running from x −8.9
    // km to +12.1 km around a region 2 km across — meshing those would drape
    // ribbons over 20 km of clamped, perfectly flat nothing.
    const roads = clipRoadsToRegion(region.roads, half)
    const height = (x: number, z: number) => heightField.heightAt(x, z)
    const slope = (x: number, z: number) => heightField.slopeAt(x, z)

    report('بناء شبكة الطرق', 0.3)
    const surfaces: SurfaceMaterial[] = []
    const multis: MultiMaterial[] = []
    const roadMesh = buildRoads(scene, roads, height, options.palette, surfaces, multis)
    await yieldToBrowser()

    // Wall and roof materials are created up front and shared by the generated
    // and the mapped buildings alike, so the two meshes cost two draw calls
    // between them rather than four.
    const wall = ensureSurface(scene, surfaces, 'building:wall', 1, options.palette)
    const roof = ensureSurface(scene, surfaces, 'building:roof', 1, options.palette)

    let buildingMesh: Mesh | null = null
    const standing: GeneratedBuilding[] = []
    if (options.generateBuildings) {
      report('استنتاج قطع الأراضي', 0.45)
      const plots = inferPlots(roads, region.buildings, slope, DEFAULT_PLOTS)
      await yieldToBrowser()

      report('توليد المباني', 0.62)
      const generated = buildingsFromPlots(plots, DEFAULT_PLOTS.seed)
      await yieldToBrowser()

      buildingMesh = buildBuildings(scene, 'regionBuildings', generated, height, wall, roof, multis)
      standing.push(...generated)
      await yieldToBrowser()
    }

    report('وضع المباني المرسومة', 0.88)
    const mapped = region.buildings
      .filter((b) => b.ring.length >= 3 && insideRegion(b.ring[0], half))
      .map(mappedToGenerated)
    const mappedBuildingMesh = buildBuildings(scene, 'regionMapped', mapped, height, wall, roof, multis)
    standing.push(...mapped)
    await yieldToBrowser()

    report('حساب إحصاءات المنطقة', 0.95)
    // Grades measured on the graded surface, not the satellite hill: this is the
    // honest answer to "will the truck climb this?".
    const stats = describeRegion(region, height)

    const built = new RegionScene({
      scene,
      heightField,
      stats,
      roads,
      roadMesh,
      buildingMesh,
      mappedBuildingMesh,
      buildings: standing,
      surfaces,
      multis,
    })
    built.registerShadowCasters()

    report('جاهز', 1)
    return built
  }

  // ------------------------------------------------------------------ palette

  /**
   * Re-dress every surface without touching a vertex.
   *
   * Colour, roughness, metallic and tiling all live on the materials, and the
   * per-house variation lives in a vertex colour buffer that is normalised
   * against the default palette at build time. So a colour change is half a
   * dozen property writes and the next frame shows it — no re-triangulation, no
   * buffer upload, no reload.
   */
  applyPalette(palette: Palette): void {
    for (const surface of this.surfaces) {
      this.applyStyle(surface, palette[surface.key] ?? DEFAULT_PALETTE[surface.key])
    }
  }

  private applyStyle(surface: SurfaceMaterial, style: SurfaceStyle): void {
    // No sRGB→linear conversion, deliberately: every other material in this
    // engine (Environment, Terrain, the vehicle) feeds Color3 literals straight
    // to albedoColor, and converting only here would make the region read
    // noticeably darker than the props standing on it.
    surface.mat.albedoColor = Color3.FromHexString(style.color)
    surface.mat.roughness = style.roughness
    surface.mat.metallic = style.metallic

    if (style.textureUrl !== surface.textureUrl) {
      surface.texture?.dispose()
      surface.texture = style.textureUrl ? new Texture(style.textureUrl, this.scene) : null
      surface.textureUrl = style.textureUrl
      surface.mat.albedoTexture = surface.texture
    }
    if (surface.texture) {
      const scale = surface.uvMetres / Math.max(0.05, style.tileMetres)
      surface.texture.wrapU = Texture.WRAP_ADDRESSMODE
      surface.texture.wrapV = Texture.WRAP_ADDRESSMODE
      surface.texture.uScale = scale
      surface.texture.vScale = scale
    }
  }

  // -------------------------------------------------------------------- spawn

  /**
   * A flat spot beside a residential street, facing along it.
   *
   * Beside a road, never the region centre. The centre of a baked region is
   * wherever the bbox happened to land — in Khalidiya it is a slope with no
   * street on it, and a truck dropped there starts nose-down in open ground
   * with no route out. The roads are the one part of the terrain that has been
   * graded (see RegionHeightField.flattenRoads): they are guaranteed flat
   * across their width, capped in gradient along their length, and connected to
   * the rest of the network. Spawning on the kerb line means the first thing
   * the player sees is a street they can drive down.
   *
   * Residential is preferred over the secondary roads for the same reason a
   * driving lesson starts on one: no through-traffic geometry, gentler grades,
   * and houses either side to give the scene scale.
   */
  findSpawn(): { x: number; z: number; yaw: number } {
    const half = this.heightField.sizeM * 0.5
    // Classes are tried in order of preference and the first one that has any
    // street at all wins, so a region with residential roads never spawns the
    // player on a service alley just because one alley happened to score better.
    for (const cls of SPAWNABLE) {
      const found = this.bestSpawnOn(cls, half)
      if (found) return found
    }
    // No drivable street in the region at all. The centre is the only honest
    // fallback left, and it is the answer this method exists to avoid.
    return { x: 0, z: 0, yaw: 0 }
  }

  private bestSpawnOn(cls: RoadClass, half: number): { x: number; z: number; yaw: number } | null {
    let best: { x: number; z: number; yaw: number } | null = null
    let bestScore = Infinity

    for (const road of this.roads) {
      if (road.cls !== cls) continue
      const total = roadLength(road)
      if (total < SPAWN_EDGE_M * 2 + SPAWN_STEP_M) continue

      for (let d = SPAWN_EDGE_M; d <= total - SPAWN_EDGE_M; d += SPAWN_STEP_M) {
        const at = pointAlong(road.pts, d)
        if (!at) continue

        // Park off the centreline, on the side whose ground is flatter — on a
        // cross-slope one kerb sits in the cutting and the other on the fill.
        const off = Math.max(0.25, road.halfWidth) * SPAWN_OFFSET
        for (let side = -1; side <= 1; side += 2) {
          const x = at.x + at.tz * side * off
          const z = at.z - at.tx * side * off
          const score = this.spawnScore(x, z, half)
          if (score >= bestScore) continue
          bestScore = score
          // atan2(x, z) is the engine's yaw convention throughout.
          best = { x, z, yaw: Math.atan2(at.tx, at.tz) }
        }
      }
    }

    return best
  }

  /** Lower is better: worst slope under the vehicle, plus an edge penalty. */
  private spawnScore(x: number, z: number, half: number): number {
    let worst = this.heightField.slopeAt(x, z)
    for (let i = 0; i < 4; i++) {
      const sx = x + ((i & 1) === 0 ? -SPAWN_PROBE_M : SPAWN_PROBE_M)
      const sz = z + ((i & 2) === 0 ? -SPAWN_PROBE_M : SPAWN_PROBE_M)
      const s = this.heightField.slopeAt(sx, sz)
      if (s > worst) worst = s
    }
    const edge = Math.max(Math.abs(x), Math.abs(z)) / half
    return worst + edge * SPAWN_EDGE_PENALTY
  }

  // ------------------------------------------------------------- visibility

  /**
   * Hide every building, mapped ones included: the toggle means "show me the
   * street network", and leaving the one surveyed footprint standing alone in
   * an empty region would read as a bug rather than as data.
   *
   * setEnabled rather than isVisible, so the meshes leave the render list
   * entirely instead of being submitted and discarded.
   */
  setBuildingsVisible(on: boolean): void {
    this.buildingMesh?.setEnabled(on)
    this.mappedBuildingMesh?.setEnabled(on)
  }

  // ---------------------------------------------------------------- shadows

  /**
   * Register the buildings with whatever shadow generator the scene's lights
   * carry — the same addShadowCaster call Environment makes for its props.
   *
   * The generator is discovered from the scene rather than passed in, because
   * the build() signature is fixed by the contract and Environment owns the
   * only generator. IShadowGenerator does not declare addShadowCaster (only the
   * concrete generators do), so the presence of the method is what is tested.
   *
   * Roads are pointedly NOT casters. A ribbon lying 12 cm above the ground it
   * follows casts nothing but shadow-acne onto itself, at the cost of pushing
   * the whole 87.8 km network through every cascade.
   */
  private registerShadowCasters(): void {
    const casters = [this.buildingMesh, this.mappedBuildingMesh].filter(
      (m): m is Mesh => m !== null,
    )
    if (casters.length === 0) return

    for (const light of this.scene.lights) {
      const gen = light.getShadowGenerator() as unknown as {
        addShadowCaster?: (mesh: AbstractMesh, includeDescendants?: boolean) => unknown
      } | null
      if (!gen || typeof gen.addShadowCaster !== 'function') continue
      for (const mesh of casters) gen.addShadowCaster(mesh)
    }
  }

  // ---------------------------------------------------------------- teardown

  dispose(): void {
    for (const mesh of [this.roadMesh, this.buildingMesh, this.mappedBuildingMesh]) mesh?.dispose()
    for (const multi of this.multis) multi.dispose()
    for (const surface of this.surfaces) {
      surface.texture?.dispose()
      surface.mat.dispose()
    }
  }
}

// ---------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------

/** Contiguous run of index buffer sharing one surface key. */
interface RoadSlot {
  key: SurfaceKey
  indexStart: number
  indexCount: number
  vertexStart: number
  vertexCount: number
}

function buildRoads(
  scene: Scene,
  roads: RegionRoad[],
  height: (x: number, z: number) => number,
  palette: Palette,
  surfaces: SurfaceMaterial[],
  multis: MultiMaterial[],
): Mesh | null {
  const geo = buildRoadGeometry(roads, height, DEFAULT_ROAD_MESH)
  if (geo.indices.length === 0) return null

  // roadMesh emits its groups in a fixed coarsest-first class order, and
  // roadClassToKey collapses that order into runs — motorway…tertiary all land
  // on road:major, unclassified…living_street on road:residential — so merging
  // neighbours by key always yields contiguous index ranges and never more than
  // four of them.
  const slots: RoadSlot[] = []
  for (const group of geo.groups) {
    if (group.indexCount === 0) continue
    const key = roadClassToKey(group.cls)
    const last = slots[slots.length - 1]
    if (last && last.key === key) last.indexCount += group.indexCount
    else slots.push({ key, indexStart: group.indexStart, indexCount: group.indexCount, vertexStart: 0, vertexCount: 0 })
  }
  if (slots.length === 0) return null

  for (const slot of slots) {
    const span = vertexSpan(geo.indices, slot.indexStart, slot.indexCount)
    slot.vertexStart = span.first
    slot.vertexCount = span.total
  }

  const mesh = new Mesh('regionRoads', scene)
  const data = new VertexData()
  data.positions = geo.positions
  data.normals = geo.normals
  data.uvs = geo.uvs
  data.indices = geo.indices
  data.applyToMesh(mesh, false)

  const multi = new MultiMaterial('regionRoadsMat', scene)
  // Road UVs are normalised to the carriageway: u spans the full width, v is
  // measured in road-widths. So one UV unit is one carriageway wide, and the
  // length-weighted mean width of the class is what turns the palette's
  // tileMetres into a texture scale.
  multi.subMaterials = slots.map(
    (slot) => ensureSurface(scene, surfaces, slot.key, meanCarriagewayM(roads, slot.key), palette).mat,
  )
  mesh.material = multi
  multis.push(multi)

  mesh.subMeshes = []
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    new SubMesh(i, slot.vertexStart, slot.vertexCount, slot.indexStart, slot.indexCount, mesh)
  }

  mesh.receiveShadows = true
  // Ground contact is resolved analytically against MudField, never by picking.
  mesh.isPickable = false
  // One mesh spanning the whole 2 km square with the camera always inside it:
  // the frustum test can only ever answer "visible", so skip it.
  mesh.alwaysSelectAsActiveMesh = true
  return mesh
}

/** Length-weighted mean full carriageway width of one surface key, metres. */
function meanCarriagewayM(roads: RegionRoad[], key: SurfaceKey): number {
  let num = 0
  let den = 0
  for (const road of roads) {
    if (roadClassToKey(road.cls) !== key) continue
    const len = roadLength(road)
    if (!(len > 0)) continue
    num += (Math.max(0.25, road.halfWidth) + DEFAULT_ROAD_MESH.shoulder) * 2 * len
    den += len
  }
  // Six metres is an ordinary two-lane street here, and is only ever reached
  // when a key has no road at all — in which case nothing samples it.
  return den > 0 ? num / den : 6
}

/** Lowest and highest vertex referenced by a slice of the index buffer. */
function vertexSpan(indices: Uint32Array, start: number, count: number): { first: number; total: number } {
  let lo = Infinity
  let hi = -Infinity
  for (let i = start; i < start + count; i++) {
    const v = indices[i]
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!Number.isFinite(lo)) return { first: 0, total: 0 }
  return { first: lo, total: hi - lo + 1 }
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

/**
 * Extrude a set of footprints into one mesh with two SubMeshes.
 *
 * buildBuildingGeometry interleaves each building's roof block with its wall
 * quads, so the index buffer is reordered here — roof triangles into one
 * contiguous run, wall triangles into another — which changes nothing about the
 * geometry and buys walls and roofs their own material. That matters: a flat
 * concrete roof and a dressed limestone wall want different roughness, and the
 * palette gives the user a separate swatch for each.
 */
function buildBuildings(
  scene: Scene,
  name: string,
  buildings: GeneratedBuilding[],
  height: (x: number, z: number) => number,
  wall: SurfaceMaterial,
  roof: SurfaceMaterial,
  multis: MultiMaterial[],
): Mesh | null {
  if (buildings.length === 0) return null
  const geo = buildBuildingGeometry(buildings, height)
  if (geo.indices.length === 0) return null

  normaliseBuildingColours(geo.colors, geo.normals)
  const split = splitRoofAndWalls(geo.indices, geo.normals)
  if (split.wallCount === 0 && split.roofCount === 0) return null

  const mesh = new Mesh(name, scene)
  const data = new VertexData()
  data.positions = geo.positions
  data.normals = geo.normals
  data.uvs = geo.uvs
  data.indices = split.indices
  data.colors = geo.colors
  data.applyToMesh(mesh, false)

  const multi = new MultiMaterial(`${name}Mat`, scene)
  multi.subMaterials = [wall.mat, roof.mat]
  mesh.material = multi
  multis.push(multi)

  // Both SubMeshes claim the whole vertex range. Roof and wall vertices belong
  // to the same building and are therefore interleaved building by building —
  // there is no tight span to give either — and since both cover the entire
  // neighbourhood anyway, a per-SubMesh bounding box would not cull anything.
  const vertexCount = geo.positions.length / 3
  mesh.subMeshes = []
  if (split.wallCount > 0) new SubMesh(0, 0, vertexCount, 0, split.wallCount, mesh)
  if (split.roofCount > 0) {
    new SubMesh(1, 0, vertexCount, split.wallCount, split.roofCount, mesh)
  }

  mesh.receiveShadows = true
  mesh.isPickable = false
  mesh.alwaysSelectAsActiveMesh = true
  return mesh
}

/**
 * Rewrite the baked vertex colours as factors against the default palette.
 *
 * buildBuildingGeometry bakes an absolute limestone colour per vertex. Left
 * alone that would be multiplied by the material's albedoColor and come out
 * twice as dark, and the palette swatch would have almost no authority over
 * what the user sees. Dividing by the default entry makes the shipped palette
 * an exact identity — the neighbourhood looks precisely as that module intended
 * — while any other colour shifts the whole town and keeps its house-to-house
 * variety, its string courses and its parapet tint.
 *
 * Roof vertices are the ones whose normal points straight up; walls are
 * horizontal. That is buildBuildingGeometry's documented convention and is the
 * only signal in the buffers, which is exactly why it is used rather than
 * assuming anything about the module's internal vertex layout.
 */
function normaliseBuildingColours(colors: Float32Array, normals: Float32Array): void {
  const wall = Color3.FromHexString(DEFAULT_PALETTE['building:wall'].color)
  const roof = Color3.FromHexString(DEFAULT_PALETTE['building:roof'].color)
  const wallRef = [Math.max(1e-3, wall.r), Math.max(1e-3, wall.g), Math.max(1e-3, wall.b)]
  const roofRef = [Math.max(1e-3, roof.r), Math.max(1e-3, roof.g), Math.max(1e-3, roof.b)]

  const n = normals.length / 3
  for (let i = 0; i < n; i++) {
    const ref = normals[i * 3 + 1] > 0.5 ? roofRef : wallRef
    for (let k = 0; k < 3; k++) {
      const f = colors[i * 4 + k] / ref[k]
      colors[i * 4 + k] = f > MAX_COLOUR_FACTOR ? MAX_COLOUR_FACTOR : f
    }
  }
}

/**
 * Wall triangles first, then roof triangles, both contiguous.
 *
 * Two forward passes rather than one clever pass filling from both ends: the
 * two-ended version has to reverse the roof block afterwards, and that reversal
 * reads and writes the same region of the buffer. Both blocks keep the order
 * the extruder emitted them in, which is what the GPU's post-transform vertex
 * cache wants.
 */
function splitRoofAndWalls(
  indices: Uint32Array,
  normals: Float32Array,
): { indices: Uint32Array; wallCount: number; roofCount: number } {
  const out = new Uint32Array(indices.length)
  // Every vertex of a triangle belongs to one face, so one lookup decides it:
  // roofs point straight up, walls are horizontal.
  const isRoof = (i: number) => normals[indices[i] * 3 + 1] > 0.5

  let o = 0
  for (let i = 0; i < indices.length; i += 3) {
    if (isRoof(i)) continue
    out[o++] = indices[i]
    out[o++] = indices[i + 1]
    out[o++] = indices[i + 2]
  }
  const wallCount = o

  for (let i = 0; i < indices.length; i += 3) {
    if (!isRoof(i)) continue
    out[o++] = indices[i]
    out[o++] = indices[i + 1]
    out[o++] = indices[i + 2]
  }

  return { indices: out, wallCount, roofCount: o - wallCount }
}

/**
 * A surveyed OSM footprint, dressed so it goes through the same extruder as the
 * generated houses.
 *
 * Its colour is the default wall entry exactly, which normalises to a factor of
 * 1: real buildings carry no invented per-house variation, so they take the
 * palette colour as-is and stand out from the generated stock only by having a
 * true footprint. Storeys are read back from the mapped height rather than
 * rolled, so the string courses land on the real floor lines.
 */
function mappedToGenerated(b: RegionBuilding): GeneratedBuilding {
  const height = Math.max(2, b.height)
  return {
    ring: b.ring,
    height,
    style: {
      color: Color3.FromHexString(DEFAULT_PALETTE['building:wall'].color),
      // Flat roofs behind a parapet are near-universal in the region, and the
      // one mapped building here is no exception.
      roof: 'parapet',
      storeys: Math.max(1, Math.round(height / 3.05)),
      bandChance: 0.35,
    },
  }
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function ensureSurface(
  scene: Scene,
  surfaces: SurfaceMaterial[],
  key: SurfaceKey,
  uvMetres: number,
  palette: Palette,
): SurfaceMaterial {
  const found = surfaces.find((s) => s.key === key)
  if (found) return found

  const mat = new PBRMaterial(`region:${key}`, scene)
  // Opaque, stated rather than left to the default: PBRMaterial reads vertex
  // ALPHA whenever the transparency mode is not explicitly opaque, which costs
  // a blend path the region never needs.
  mat.transparencyMode = PBRMaterial.MATERIAL_OPAQUE
  mat.backFaceCulling = true
  mat.specularIntensity = 0.5

  const surface: SurfaceMaterial = { key, mat, uvMetres, textureUrl: null, texture: null }
  const style = palette[key] ?? DEFAULT_PALETTE[key]
  mat.albedoColor = Color3.FromHexString(style.color)
  mat.roughness = style.roughness
  mat.metallic = style.metallic
  if (style.textureUrl) {
    const tex = new Texture(style.textureUrl, scene)
    tex.wrapU = Texture.WRAP_ADDRESSMODE
    tex.wrapV = Texture.WRAP_ADDRESSMODE
    const scale = uvMetres / Math.max(0.05, style.tileMetres)
    tex.uScale = scale
    tex.vScale = scale
    mat.albedoTexture = tex
    surface.texture = tex
    surface.textureUrl = style.textureUrl
  }

  surfaces.push(surface)
  return surface
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function insideRegion(p: RegionPoint, half: number): boolean {
  return Math.abs(p.x) <= half && Math.abs(p.z) <= half
}

/**
 * Clip every centreline to the region square, splitting a way that leaves and
 * re-enters into separate roads.
 *
 * Liang–Barsky per segment. Class, width and name are carried onto each piece,
 * so a clipped road is still a road as far as the mesher and the plot inference
 * are concerned.
 */
function clipRoadsToRegion(roads: RegionRoad[], half: number): RegionRoad[] {
  const out: RegionRoad[] = []

  for (const road of roads) {
    if (road.pts.length < 2) continue
    let run: RegionPoint[] = []

    const flush = () => {
      if (run.length >= 2) out.push({ ...road, pts: run })
      run = []
    }

    for (let i = 0; i + 1 < road.pts.length; i++) {
      const a = road.pts[i]
      const b = road.pts[i + 1]
      const t = clipSegment(a.x, a.z, b.x, b.z, half)
      if (!t) {
        flush()
        continue
      }
      const p0 = { x: a.x + (b.x - a.x) * t[0], z: a.z + (b.z - a.z) * t[0] }
      const p1 = { x: a.x + (b.x - a.x) * t[1], z: a.z + (b.z - a.z) * t[1] }
      const tail = run[run.length - 1]
      // A gap between the previous piece's exit and this one's entry means the
      // way left the square in between, so the run has to break.
      if (!tail || Math.hypot(tail.x - p0.x, tail.z - p0.z) > EPS) {
        flush()
        run.push(p0)
      }
      run.push(p1)
    }
    flush()
  }

  return out
}

/** Parametric span of a segment inside the square, or null if it misses. */
function clipSegment(
  ax: number, az: number,
  bx: number, bz: number,
  half: number,
): [number, number] | null {
  const dx = bx - ax
  const dz = bz - az
  let t0 = 0
  let t1 = 1
  const p = [-dx, dx, -dz, dz]
  const q = [ax + half, half - ax, az + half, half - az]

  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < EPS) {
      // Parallel to this edge: entirely in or entirely out, no clipping to do.
      if (q[i] < 0) return null
      continue
    }
    const r = q[i] / p[i]
    if (p[i] < 0) {
      if (r > t1) return null
      if (r > t0) t0 = r
    } else {
      if (r < t0) return null
      if (r < t1) t1 = r
    }
  }
  return t1 - t0 > EPS ? [t0, t1] : null
}

/** Point and unit tangent at arc length `d` along a polyline. */
function pointAlong(
  pts: RegionPoint[],
  d: number,
): { x: number; z: number; tx: number; tz: number } | null {
  let walked = 0
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    if (len < EPS) continue
    if (walked + len >= d) {
      const t = (d - walked) / len
      return {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        tx: (b.x - a.x) / len,
        tz: (b.z - a.z) / len,
      }
    }
    walked += len
  }
  return null
}

/**
 * Hand the frame back to the browser.
 *
 * setTimeout rather than a microtask: a resolved promise chains inside the same
 * task and would never let the compositor paint, so the progress bar would jump
 * straight from 0 to 1 with a frozen second in between.
 */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
