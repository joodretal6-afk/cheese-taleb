import { Color3 } from '@babylonjs/core'
import type { RegionPoint, RoadClass } from './types'
import type { Plot } from './plots'

/**
 * Building geometry for a baked region.
 *
 * Two jobs. First, turn any closed footprint — a real OSM ring or a generated
 * one — into walls and a roof welded into one indexed mesh with per-vertex
 * colour, so a whole neighbourhood draws with a single material. Second,
 * invent the houses OSM does not have: Khalidiya has exactly ONE mapped
 * building across 2 km², and an empty grid of streets reads as a test track,
 * not a town.
 *
 * Pure functions over plain data and typed arrays, like roadMesh: no scene, no
 * meshes, so every step can be asserted on in bare Node.
 */

export interface BuildingStyle {
  color: Color3
  roof: 'flat' | 'parapet'
  storeys: number
  bandChance: number
}

export interface GeneratedBuilding {
  ring: RegionPoint[]
  height: number
  style: BuildingStyle
}

/** Height of the roof parapet wall, metres. */
const PARAPET_M = 0.95
/** Thickness of a concrete string course between storeys, metres. */
const BAND_M = 0.32
/** Brightness multiplier for a band relative to the wall stone. */
const BAND_TINT = 1.16
/** Parapets are usually rendered concrete, a touch cooler than the facade. */
const PARAPET_TINT = 0.93
/** Bare minimum the walls are sunk below the lowest sampled corner, metres. */
const SKIRT_M = 0.6
/** Nominal storey height for the region's vernacular, metres. */
const STOREY_M = 3.05

/** Footprints below this are mapping debris and get dropped, m². */
const MIN_AREA_M2 = 2
/** Two ring points closer than this are the same point as far as walls care. */
const WELD_M = 0.02
/** Below this the ear-clipping area test is indistinguishable from zero. */
const AREA_EPS = 1e-7

// ---------------------------------------------------------------------------
// Polygon maths
// ---------------------------------------------------------------------------

/** Twice the signed area of triangle (a, b, c). Positive means CCW in (x, z). */
function cross2(
  ax: number, az: number,
  bx: number, bz: number,
  cx: number, cz: number,
): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
}

/**
 * Signed area of a ring in the (x, z) plane, positive for counter-clockwise.
 *
 * CCW here is the winding whose ear-clipped triangles come out facing +Y under
 * Babylon's normal convention — see the winding note in buildBuildingGeometry.
 */
function signedArea(ring: RegionPoint[]): number {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j].x * ring[i].z - ring[i].x * ring[j].z
  }
  return sum / 2
}

/** Inside-test against a triangle known to be CCW. Boundary counts as inside. */
function pointInTriangle(
  px: number, pz: number,
  ax: number, az: number,
  bx: number, bz: number,
  cx: number, cz: number,
): boolean {
  return (
    cross2(ax, az, bx, bz, px, pz) >= 0 &&
    cross2(bx, bz, cx, cz, px, pz) >= 0 &&
    cross2(cx, cz, ax, az, px, pz) >= 0
  )
}

/** Indices 0..n-1 as a simple fan. The graceful answer for a degenerate ring. */
function fan(n: number, reverse: boolean): Uint32Array {
  const out = new Uint32Array((n - 2) * 3)
  let o = 0
  for (let i = 1; i + 1 < n; i++) {
    if (reverse) {
      out[o++] = 0
      out[o++] = i + 1
      out[o++] = i
    } else {
      out[o++] = 0
      out[o++] = i
      out[o++] = i + 1
    }
  }
  return out
}

/**
 * Ear clipping, written out rather than pulled from a library.
 *
 * Handles arbitrary simple polygons including concave ones — OSM footprints are
 * routinely L- and U-shaped. Winding is detected and normalised first, so the
 * returned triangles always face +Y whichever way the caller wound the ring.
 * Returned indices address the ORIGINAL ring, never a reversed copy.
 *
 * Termination is guaranteed, which matters more here than optimality: the input
 * is untrusted map data that can be self-intersecting or have coincident
 * vertices. If a full lap of the ring finds no valid ear the worst candidate is
 * clipped anyway. That can emit an overlapping triangle, which is invisible on
 * a roof, whereas the textbook loop would spin forever on the same data.
 *
 * O(n²), which is the right trade at these sizes: footprints here are 4 to ~40
 * vertices, and the whole region is triangulated once at load.
 */
export function triangulatePolygon(ring: RegionPoint[]): Uint32Array {
  const n = ring.length
  if (n < 3) return new Uint32Array(0)

  const area = signedArea(ring)
  // No area means every vertex is collinear or coincident. Ear clipping has no
  // convex vertex to bite; hand back a fan and let the near-zero triangles
  // rasterise to nothing.
  if (Math.abs(area) < AREA_EPS) return fan(n, false)
  if (n === 3) return fan(n, area < 0)

  const idx: number[] = new Array(n)
  for (let i = 0; i < n; i++) idx[i] = i
  if (area < 0) idx.reverse()

  const out = new Uint32Array((n - 2) * 3)
  let o = 0
  let cursor = 0
  let stalled = 0

  while (idx.length > 3) {
    const m = idx.length
    const ia = idx[(cursor + m - 1) % m]
    const ib = idx[cursor]
    const ic = idx[(cursor + 1) % m]
    const a = ring[ia]
    const b = ring[ib]
    const c = ring[ic]

    let ear = cross2(a.x, a.z, b.x, b.z, c.x, c.z) > AREA_EPS
    if (ear) {
      for (let k = 0; k < m; k++) {
        const p = idx[k]
        if (p === ia || p === ib || p === ic) continue
        if (pointInTriangle(ring[p].x, ring[p].z, a.x, a.z, b.x, b.z, c.x, c.z)) {
          ear = false
          break
        }
      }
    }

    if (ear || stalled > m) {
      out[o++] = ia
      out[o++] = ib
      out[o++] = ic
      idx.splice(cursor, 1)
      if (cursor >= idx.length) cursor = 0
      stalled = 0
    } else {
      cursor = (cursor + 1) % m
      stalled++
    }
  }

  out[o++] = idx[0]
  out[o++] = idx[1]
  out[o++] = idx[2]
  return out
}

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/**
 * Seed mixed with a quantised world position.
 *
 * Hashing the position rather than the plot's index means a house keeps its
 * storeys and its colour when plots elsewhere in the region appear or vanish —
 * regenerate after tweaking the plot rules and only the plots you touched
 * change, instead of the entire neighbourhood re-rolling.
 */
function hashAt(seed: number, x: number, z: number, salt: number): number {
  let h = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0
  h = Math.imul(h ^ (Math.round(x * 8) | 0), 0x27d4eb2d)
  h ^= h >>> 15
  h = Math.imul(h ^ (Math.round(z * 8) | 0), 0x165667b1)
  h ^= h >>> 13
  return h >>> 0
}

/** mulberry32: tiny, fast, and identical in every JS engine we ship on. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Generated houses
// ---------------------------------------------------------------------------

/**
 * Local vernacular for Al-Khalidiya: walls are local limestone or painted
 * render, in creams, sands and pale greys. Nothing saturated, nothing dark.
 */
const PALETTE: Color3[] = [
  new Color3(0.906, 0.855, 0.741), // cream limestone
  new Color3(0.859, 0.784, 0.647), // sand
  new Color3(0.843, 0.827, 0.784), // pale grey stone
  new Color3(0.878, 0.812, 0.729), // warm beige
  new Color3(0.827, 0.749, 0.678), // pinkish stone
  new Color3(0.910, 0.886, 0.831), // whitewashed render
]

/**
 * Metres of garden kept between the house and each plot boundary.
 *
 * These are boundaries of the PLOT, not of the street: Plot.setback has already
 * held the parcel back off the kerb, so adding it again here would push every
 * house to the far end of its own garden.
 */
const FRONT_SETBACK_M = 2.4
const SIDE_SETBACK_M = 1.1
const REAR_SETBACK_M = 2.8
/** A footprint below this in either direction is a shed, not a house: skip. */
const MIN_HOUSE_M = 4.5

/**
 * Storeys by street class. Frontage on a wider road carries slightly taller
 * blocks — along the secondary roads through Khalidiya that is a mix of two-
 * and three-storey buildings with shops underneath, while the residential
 * lanes behind are mostly one and two.
 */
function storeysFor(cls: RoadClass, r: number): number {
  switch (cls) {
    case 'motorway':
    case 'trunk':
    case 'primary':
    case 'secondary':
    case 'tertiary':
      return r < 0.12 ? 1 : r < 0.5 ? 2 : 3
    case 'residential':
    case 'living_street':
    case 'unclassified':
      return r < 0.34 ? 1 : r < 0.85 ? 2 : 3
    default:
      return r < 0.68 ? 1 : 2
  }
}

/**
 * Plausible houses for plots the region has no buildings on.
 *
 * These are INVENTED. OSM knows one building in the whole 2 km² of Khalidiya,
 * so everything else here is a guess at the local pattern — a rectangular
 * block set back inside its plot, flat roof, usually a parapet, one to three
 * storeys, limestone walls. It is not survey data and must never be presented
 * as such. Anyone who maps the real buildings in OSM gets them for free: the
 * baker picks them up on the next fetch-region run, and the real footprints
 * take over from these.
 *
 * Deterministic for a given seed: same seed, byte-identical neighbourhood. A
 * plot too small to hold MIN_HOUSE_M in either direction after its garden is
 * skipped, so this returns at most one building per plot and often fewer.
 */
export function buildingsFromPlots(plots: Plot[], seed: number): GeneratedBuilding[] {
  const out: GeneratedBuilding[] = []

  for (const plot of plots) {
    if (!(plot.width > 0) || !(plot.depth > 0)) continue

    const rnd = mulberry32(hashAt(seed, plot.x, plot.z, 0))

    // Plot.facing points at the road, in the engine's atan2(x, z) yaw, so the
    // unit vector toward the kerb is (sin, cos) and the plot runs the other way.
    const ix = -Math.sin(plot.facing)
    const iz = -Math.cos(plot.facing)
    // Frontage axis: the perpendicular. Sign is free — the footprint is
    // symmetric about it.
    const ax = iz
    const az = -ix

    // Setbacks eat the plot from both sides; whatever is left, minus a little
    // jitter, is the house. Deep plots do not get absurdly deep houses.
    const usableW = plot.width - SIDE_SETBACK_M * 2
    const usableD = plot.depth - FRONT_SETBACK_M - REAR_SETBACK_M
    if (usableW < MIN_HOUSE_M || usableD < MIN_HOUSE_M) continue

    const w = Math.min(usableW * (0.84 + rnd() * 0.16), 22)
    const d = Math.min(usableD * (0.82 + rnd() * 0.18), 18)
    if (w < MIN_HOUSE_M || d < MIN_HOUSE_M) continue

    // Push the block toward the street so a row of plots reads as a frontage
    // line rather than a scatter: the plot centre sits depth/2 back from its
    // front boundary, the house only FRONT_SETBACK_M + d/2.
    const shift = FRONT_SETBACK_M + d / 2 - plot.depth / 2
    const cx = plot.x + ix * shift
    const cz = plot.z + iz * shift

    const hw = w / 2
    const hd = d / 2
    const px = ax * hw
    const pz = az * hw
    const qx = ix * hd
    const qz = iz * hd
    const ring: RegionPoint[] = [
      { x: cx - px - qx, z: cz - pz - qz },
      { x: cx + px - qx, z: cz + pz - qz },
      { x: cx + px + qx, z: cz + pz + qz },
      { x: cx - px + qx, z: cz - pz + qz },
    ]

    const storeys = storeysFor(plot.roadClass, rnd())
    // Ground floors here sit a step or two above the street.
    const height = storeys * STOREY_M + 0.35 + rnd() * 0.4

    const base = PALETTE[(rnd() * PALETTE.length) | 0]
    const shade = 0.94 + rnd() * 0.12
    const style: BuildingStyle = {
      color: new Color3(
        Math.min(1, base.r * shade),
        Math.min(1, base.g * shade),
        Math.min(1, base.b * shade),
      ),
      roof: rnd() < 0.72 ? 'parapet' : 'flat',
      storeys,
      bandChance: 0.2 + rnd() * 0.55,
    }

    out.push({ ring, height, style })
  }

  return out
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** One horizontal slice of a facade, in metres above the building's base. */
interface Span {
  y0: number
  y1: number
  tint: number
}

interface Prepared {
  ring: RegionPoint[]
  /** Ground level the building is founded on: the LOWEST sampled corner. */
  base: number
  /** Where the walls actually start, buried below `base`. */
  bottom: number
  height: number
  spans: Span[]
  parapet: boolean
  wallR: number
  wallG: number
  wallB: number
  roofR: number
  roofG: number
  roofB: number
}

/**
 * Drop repeated points and any trailing copy of the first vertex.
 *
 * OSM rings sometimes close explicitly and sometimes carry duplicate nodes; a
 * zero-length edge would produce a wall quad with no area and a NaN normal.
 */
function cleanRing(ring: RegionPoint[]): RegionPoint[] {
  const out: RegionPoint[] = []
  for (const p of ring) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - p.x) < WELD_M && Math.abs(last.z - p.z) < WELD_M) continue
    out.push(p)
  }
  while (out.length > 1) {
    const a = out[0]
    const b = out[out.length - 1]
    if (Math.abs(a.x - b.x) < WELD_M && Math.abs(a.z - b.z) < WELD_M) out.pop()
    else break
  }
  return out
}

/**
 * Split a facade into plain stone and concrete string courses.
 *
 * bandChance is resolved here, not in buildingsFromPlots, so it stays a style
 * knob rather than baked geometry — but it is resolved from a hash of the
 * building's own position, so the answer is stable across runs and identical
 * for real OSM footprints that carry no seed at all.
 */
function facadeSpans(b: GeneratedBuilding, height: number): Span[] {
  const storeys = Math.max(1, Math.round(b.style.storeys))
  const storeyH = height / storeys
  const anchor = b.ring[0]
  const spans: Span[] = []
  let y = 0

  // Candidate courses sit on each storey line, including the wall head, where
  // the cornice under the parapet is the most common one of all.
  for (let k = 1; k <= storeys; k++) {
    const chance = k === storeys ? b.style.bandChance * 1.4 : b.style.bandChance
    if (mulberry32(hashAt(0x5eed, anchor.x, anchor.z, k))() >= chance) continue
    const line = k * storeyH
    const y0 = Math.max(y + 0.05, line - BAND_M / 2)
    const y1 = Math.min(height, line + BAND_M / 2)
    if (y1 - y0 < 0.05) continue
    if (y0 > y) spans.push({ y0: y, y1: y0, tint: 1 })
    spans.push({ y0, y1, tint: BAND_TINT })
    y = y1
  }

  if (height - y > 0.02) spans.push({ y0: y, y1: height, tint: 1 })
  if (spans.length === 0) spans.push({ y0: 0, y1: height, tint: 1 })
  return spans
}

/** Flat roofs here are grey concrete, whatever colour the walls are. */
function roofColour(c: Color3): [number, number, number] {
  const mix = 0.72
  return [
    (c.r * (1 - mix) + 0.55 * mix) * 0.88,
    (c.g * (1 - mix) + 0.54 * mix) * 0.88,
    (c.b * (1 - mix) + 0.52 * mix) * 0.88,
  ]
}

/**
 * Extrude footprints into one indexed mesh.
 *
 * `height` is expected to be MudField's ground height — the single source of
 * truth every other system samples — so buildings stand on exactly the surface
 * the vehicle drives on. Ring coordinates are already local metres; nothing is
 * re-projected here.
 *
 * Founding: each footprint is sampled at its corners and founded on the LOWEST
 * of them, then the walls are extended below that. Khalidiya has 25 % grades in
 * places, and a building founded on its average corner has one corner hanging
 * three metres in the air. The skirt scales with how much the corners disagree,
 * which is the cheap proxy for how far the ground can dip between them.
 *
 * Output is one buffer set with per-vertex colour, so several thousand
 * buildings in half a dozen styles still draw as a single mesh with a single
 * material. Colours are RGBA to match Babylon's VertexBuffer.ColorKind.
 */
export function buildBuildingGeometry(
  buildings: GeneratedBuilding[],
  height: (x: number, z: number) => number,
): {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  indices: Uint32Array
  colors: Float32Array
} {
  const prepared: Prepared[] = []
  let vertCount = 0
  let indexCount = 0

  for (const b of buildings) {
    const cleaned = cleanRing(b.ring)
    if (cleaned.length < 3) continue

    const area = signedArea(cleaned)
    if (Math.abs(area) < MIN_AREA_M2) continue
    // Walls need a known orientation to point their normals outward, so the
    // ring is normalised to CCW here once and used for roof and walls alike.
    const ring = area < 0 ? cleaned.slice().reverse() : cleaned

    let lo = Infinity
    let hi = -Infinity
    for (const p of ring) {
      const g = height(p.x, p.z)
      if (g < lo) lo = g
      if (g > hi) hi = g
    }
    if (!Number.isFinite(lo)) continue

    const h = Math.max(2, b.height)
    const spans = facadeSpans(b, h)
    const parapet = b.style.roof === 'parapet'
    const roof = roofColour(b.style.color)

    prepared.push({
      ring,
      base: lo,
      bottom: lo - (SKIRT_M + (hi - lo) * 0.35),
      height: h,
      spans,
      parapet,
      wallR: b.style.color.r,
      wallG: b.style.color.g,
      wallB: b.style.color.b,
      roofR: roof[0],
      roofG: roof[1],
      roofB: roof[2],
    })

    const n = ring.length
    const quads = n * spans.length + (parapet ? n * 2 : 0)
    vertCount += n + quads * 4
    indexCount += (n - 2) * 3 + quads * 6
  }

  const positions = new Float32Array(vertCount * 3)
  const normals = new Float32Array(vertCount * 3)
  const uvs = new Float32Array(vertCount * 2)
  const colors = new Float32Array(vertCount * 4)
  const indices = new Uint32Array(indexCount)

  let v = 0
  let o = 0

  for (const p of prepared) {
    const ring = p.ring
    const n = ring.length
    const roofY = p.base + p.height

    // Roof first, so the triangulation indices land on a contiguous block.
    const roofBase = v
    for (let i = 0; i < n; i++) {
      positions[v * 3] = ring[i].x
      positions[v * 3 + 1] = roofY
      positions[v * 3 + 2] = ring[i].z
      normals[v * 3 + 1] = 1
      // Roof UVs are world metres, so gravel and water tanks tile at the same
      // scale on every building regardless of footprint size.
      uvs[v * 2] = ring[i].x
      uvs[v * 2 + 1] = ring[i].z
      colors[v * 4] = p.roofR
      colors[v * 4 + 1] = p.roofG
      colors[v * 4 + 2] = p.roofB
      colors[v * 4 + 3] = 1
      v++
    }
    const tri = triangulatePolygon(ring)
    for (let i = 0; i < tri.length; i++) indices[o++] = roofBase + tri[i]

    let u = 0
    for (let e = 0; e < n; e++) {
      const a = ring[e]
      const b = ring[(e + 1) % n]
      const dx = b.x - a.x
      const dz = b.z - a.z
      const len = Math.hypot(dx, dz) || 1
      // For a CCW ring the interior is to the left of a→b, so the outward
      // normal is (dz, −dx).
      const nx = dz / len
      const nz = -dx / len
      const u0 = u
      const u1 = u + len
      u = u1

      const quads = p.parapet ? p.spans.length + 2 : p.spans.length
      for (let s = 0; s < quads; s++) {
        const span = s < p.spans.length ? p.spans[s] : null
        // The last two quads on a parapet building are the parapet itself,
        // emitted twice: once outward, once inward. It is a zero-thickness
        // wall, so without the second copy the roof would look open from above.
        const inward = s === p.spans.length + 1

        let y0: number
        let y1: number
        let tint: number
        if (span) {
          y0 = s === 0 ? p.bottom : p.base + span.y0
          y1 = p.base + span.y1
          tint = span.tint
        } else {
          y0 = roofY
          y1 = roofY + PARAPET_M
          tint = PARAPET_TINT
        }

        const sx = inward ? -nx : nx
        const sz = inward ? -nz : nz
        const r = p.wallR * tint
        const g = p.wallG * tint
        const bl = p.wallB * tint
        const q = v

        // Four corners: b0, b1, t0, t1. UVs are metres — u along the facade,
        // v above the building base — so a facade texture tiles at real scale
        // and lines up across every wall of the block.
        const cornerX = [a.x, b.x, a.x, b.x]
        const cornerZ = [a.z, b.z, a.z, b.z]
        const cornerY = [y0, y0, y1, y1]
        const cornerU = [u0, u1, u0, u1]
        for (let k = 0; k < 4; k++) {
          positions[v * 3] = cornerX[k]
          positions[v * 3 + 1] = cornerY[k]
          positions[v * 3 + 2] = cornerZ[k]
          normals[v * 3] = sx
          normals[v * 3 + 1] = 0
          normals[v * 3 + 2] = sz
          uvs[v * 2] = cornerU[k]
          uvs[v * 2 + 1] = cornerY[k] - p.base
          colors[v * 4] = r
          colors[v * 4 + 1] = g
          colors[v * 4 + 2] = bl
          colors[v * 4 + 3] = 1
          v++
        }

        // Winding matters: Babylon is left-handed, and the opposite order
        // leaves the facade back-facing and therefore invisible from outside.
        // (b0, b1, t0) then (b1, t1, t0) gives an outward normal for a CCW
        // ring; the inward parapet copy is the exact mirror of that.
        if (!inward) {
          indices[o++] = q
          indices[o++] = q + 1
          indices[o++] = q + 2
          indices[o++] = q + 1
          indices[o++] = q + 3
          indices[o++] = q + 2
        } else {
          indices[o++] = q
          indices[o++] = q + 2
          indices[o++] = q + 1
          indices[o++] = q + 1
          indices[o++] = q + 2
          indices[o++] = q + 3
        }
      }
    }
  }

  return { positions, normals, uvs, indices, colors }
}
