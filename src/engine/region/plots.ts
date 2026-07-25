import type { RegionBuilding, RegionRoad, RoadClass } from './types'

/**
 * Building plots inferred from the street network.
 *
 * OSM knows Al-Khalidiya's streets in full — 155 ways, 87.8 km — and exactly one
 * building. A neighbourhood cannot be populated from that, so the plots are
 * derived from the thing that *is* mapped: people build along frontage, set back
 * from the kerb, at a rhythm set by the class of the street. Walking the
 * centrelines and placing rectangles either side reconstructs that rhythm
 * without inventing a road layout.
 *
 * Pure functions over plain data and a callback for ground slope, so the whole
 * thing runs and can be asserted on in bare Node with no Babylon and no scene.
 */

export interface Plot {
  x: number
  z: number
  /** Yaw from the plot toward its road, radians, atan2(x, z) like the rest of the engine. */
  facing: number
  /** Along the road, metres. */
  width: number
  /** Away from the road, metres. */
  depth: number
  /** Metres of open ground between the carriageway edge and the plot's front edge. */
  setback: number
  roadClass: RoadClass
}

export interface PlotOptions {
  /** Base spacing along the kerb, before the per-class multiplier. */
  frontageM: number
  /** Base plot depth, before the per-class multiplier. */
  depthM: number
  /** Base setback from the carriageway edge, before the per-class multiplier. */
  setbackM: number
  /** Steepest buildable ground, dimensionless gradient — 0.3 is a 30% slope. */
  maxSlope: number
  /** Minimum air a plot keeps around itself: to carriageway edges and buildings. */
  clearanceM: number
  seed: number
}

export const DEFAULT_PLOTS: PlotOptions = {
  // A quarter-dunum plot, ~290 m², which is the ordinary Jordanian residential
  // lot and matches the 139 m² footprint of the one building OSM does have here.
  frontageM: 16,
  depthM: 18,
  setbackM: 4,
  // The region only spans 594–661 m over 2 km, so this rejects the wadi banks
  // and the odd cut left by road flattening, not whole streets.
  maxSlope: 0.3,
  clearanceM: 2.5,
  seed: 8531,
}

/** Nobody fronts a house onto a staircase. */
const NO_FRONTAGE = new Set<RoadClass>(['footway', 'path', 'steps', 'pedestrian'])

/**
 * Per-class multipliers on [frontage, depth, setback].
 *
 * A secondary road carries through-traffic and villas: wider, deeper plots held
 * further back off the noise. A service alley gets whatever fits behind them.
 */
const CLASS_SIZE: Partial<Record<RoadClass, readonly [number, number, number]>> = {
  motorway: [1.6, 1.6, 2.4],
  trunk: [1.6, 1.6, 2.2],
  primary: [1.5, 1.45, 1.9],
  secondary: [1.35, 1.35, 1.6],
  tertiary: [1.2, 1.2, 1.3],
  unclassified: [1.1, 1.1, 1.15],
  residential: [1, 1, 1],
  living_street: [0.95, 0.95, 0.85],
  service: [0.85, 0.9, 0.7],
  track: [0.9, 1.15, 1.25],
}

const DEFAULT_SIZE: readonly [number, number, number] = [1, 1, 1]

/**
 * Fraction of the stride a plot actually occupies. The remainder is the side
 * gap, and it must stay wider than clearanceM or neighbours reject each other:
 * at the default 16 m stride the tightest pair still leaves 0.88 × 16 → 1.9 m
 * of air, against a 1.25 m requirement.
 */
const WIDTH_MIN = 0.70
const WIDTH_MAX = 0.88

/** Along-road wobble as a fraction of the stride. Bigger than half the side gap
 * and plots start knocking each other out — which is allowed, it just thins the
 * street front. */
const SLIDE = 0.05

/** Setback and depth wobble, fraction of the class value. */
const SETBACK_JITTER = 0.22
const DEPTH_JITTER = 0.16

/** Segments shorter than this are noise in the OSM geometry. */
const EPS = 1e-4

/**
 * Seeded hash, same shape as noise.ts's. Keyed on (road, step, channel) rather
 * than drawn from a running stream, so a plot's jitter depends only on where it
 * is — rejecting a neighbour never shifts the rest of the street.
 */
function hash3(a: number, b: number, c: number, seed: number): number {
  let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 1442695041)
  h = (h ^ Math.imul(seed, 1274126177)) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 1274126177) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** An oriented box. u is the unit width axis; the depth axis is v = (−u.z, u.x). */
interface Obb {
  cx: number
  cz: number
  ux: number
  uz: number
  hw: number
  hd: number
}

function axisAlignedObb(minX: number, minZ: number, maxX: number, maxZ: number): Obb {
  return {
    cx: (minX + maxX) * 0.5,
    cz: (minZ + maxZ) * 0.5,
    ux: 1,
    uz: 0,
    hw: (maxX - minX) * 0.5,
    hd: (maxZ - minZ) * 0.5,
  }
}

/** Extent of the box's AABB, so it can be bucketed and queried. */
function extentX(b: Obb): number {
  return b.hw * Math.abs(b.ux) + b.hd * Math.abs(b.uz)
}

function extentZ(b: Obb): number {
  return b.hw * Math.abs(b.uz) + b.hd * Math.abs(b.ux)
}

/** Projection radius of a box onto a unit axis. */
function projectRadius(b: Obb, nx: number, nz: number): number {
  return b.hw * Math.abs(b.ux * nx + b.uz * nz) + b.hd * Math.abs(-b.uz * nx + b.ux * nz)
}

/**
 * Separating-axis overlap of two boxes, with `pad` metres of required air added
 * around `a`. Four axes is the whole test in 2D.
 */
function obbOverlap(a: Obb, b: Obb, pad: number): boolean {
  const dx = b.cx - a.cx
  const dz = b.cz - a.cz
  const padded: Obb = pad > 0 ? { ...a, hw: a.hw + pad, hd: a.hd + pad } : a
  const axes = [
    [padded.ux, padded.uz],
    [-padded.uz, padded.ux],
    [b.ux, b.uz],
    [-b.uz, b.ux],
  ]
  for (const [nx, nz] of axes) {
    const gap = Math.abs(dx * nx + dz * nz)
    if (gap >= projectRadius(padded, nx, nz) + projectRadius(b, nx, nz)) return false
  }
  return true
}

/** Distance from a point to an axis-aligned box centred on the origin. */
function pointBoxDistance(px: number, pz: number, hw: number, hd: number): number {
  const dx = Math.max(Math.abs(px) - hw, 0)
  const dz = Math.max(Math.abs(pz) - hd, 0)
  return Math.hypot(dx, dz)
}

function pointSegmentDistance(
  px: number, pz: number,
  ax: number, az: number,
  bx: number, bz: number,
): number {
  const ex = bx - ax
  const ez = bz - az
  const len2 = ex * ex + ez * ez
  let t = len2 > 0 ? ((px - ax) * ex + (pz - az) * ez) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (ax + ex * t), pz - (az + ez * t))
}

/**
 * Shortest distance from a segment to an oriented box; 0 if they touch.
 *
 * Worked in the box's own frame, where it is axis-aligned: a Liang–Barsky slab
 * clip answers intersection, and for the disjoint case the minimum between two
 * convex polygons always lands on a vertex of one, so checking the two endpoints
 * against the box and the four corners against the segment is exact rather than
 * an approximation.
 */
function segmentBoxDistance(
  box: Obb,
  ax: number, az: number,
  bx: number, bz: number,
): number {
  const a0 = ax - box.cx
  const a1 = az - box.cz
  const b0 = bx - box.cx
  const b1 = bz - box.cz
  const px = a0 * box.ux + a1 * box.uz
  const pz = -a0 * box.uz + a1 * box.ux
  const qx = b0 * box.ux + b1 * box.uz
  const qz = -b0 * box.uz + b1 * box.ux

  const dx = qx - px
  const dz = qz - pz
  let t0 = 0
  let t1 = 1
  let clipped = true
  const p = [-dx, dx, -dz, dz]
  const q = [px + box.hw, box.hw - px, pz + box.hd, box.hd - pz]
  for (let i = 0; i < 4 && clipped; i++) {
    if (Math.abs(p[i]) < EPS) {
      if (q[i] < 0) clipped = false
      continue
    }
    const r = q[i] / p[i]
    if (p[i] < 0) {
      if (r > t1) clipped = false
      else if (r > t0) t0 = r
    } else {
      if (r < t0) clipped = false
      else if (r < t1) t1 = r
    }
  }
  if (clipped) return 0

  let best = Math.min(
    pointBoxDistance(px, pz, box.hw, box.hd),
    pointBoxDistance(qx, qz, box.hw, box.hd),
  )
  for (let i = 0; i < 4; i++) {
    const cx = (i & 1) === 0 ? -box.hw : box.hw
    const cz = (i & 2) === 0 ? -box.hd : box.hd
    const d = pointSegmentDistance(cx, cz, px, pz, qx, qz)
    if (d < best) best = d
  }
  return best
}

/**
 * Uniform bucket grid over world metres.
 *
 * This is what keeps the whole thing near linear. Around 11 000 candidates are
 * generated along 87.8 km of kerb, and testing each against every plot already
 * placed plus every one of ~2 600 road segments is tens of millions of rectangle
 * tests. Bucketing by cell turns each candidate into a handful of tests against
 * the few neighbours that could possibly touch it.
 */
class BucketGrid {
  private readonly cells = new Map<number, number[]>()
  private readonly cell: number

  constructor(cell: number) {
    this.cell = cell
  }

  /** One numeric key, so the Map hashes an int instead of building a string. */
  private static key(col: number, row: number): number {
    return (col + 32768) * 65536 + (row + 32768)
  }

  insert(minX: number, minZ: number, maxX: number, maxZ: number, id: number): void {
    const c0 = Math.floor(minX / this.cell)
    const c1 = Math.floor(maxX / this.cell)
    const r0 = Math.floor(minZ / this.cell)
    const r1 = Math.floor(maxZ / this.cell)
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = BucketGrid.key(c, r)
        const bucket = this.cells.get(k)
        if (bucket) bucket.push(id)
        else this.cells.set(k, [id])
      }
    }
  }

  /**
   * Ids in every cell the query box touches, written into `out`. An id spanning
   * several cells can come back more than once; both callers' tests are
   * idempotent, so deduplicating would cost more than the repeat test does.
   */
  query(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): void {
    out.length = 0
    const c0 = Math.floor(minX / this.cell)
    const c1 = Math.floor(maxX / this.cell)
    const r0 = Math.floor(minZ / this.cell)
    const r1 = Math.floor(maxZ / this.cell)
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const bucket = this.cells.get(BucketGrid.key(c, r))
        if (bucket) for (const id of bucket) out.push(id)
      }
    }
  }
}

interface RoadSegment {
  ax: number
  az: number
  bx: number
  bz: number
  /** Carriageway half-width plus whatever clearance the caller asked for. */
  keepOut: number
  road: number
  index: number
}

function cumulative(pts: { x: number; z: number }[]): Float64Array {
  const cum = new Float64Array(pts.length)
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
  }
  return cum
}

/** Segment index containing arc-length `d`. */
function locate(cum: Float64Array, d: number): number {
  let lo = 0
  let hi = cum.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (cum[mid] <= d) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Infer building plots from the road network.
 *
 * `slopeAt` is expected to be the same ground the vehicle drives on — normally
 * RegionHeightField.slopeAt after flattenRoads, so plots are judged against the
 * graded surface rather than the raw satellite hill.
 *
 * Roads are taken exactly as given, and there is no region square in this
 * signature to clip against. That matters: the baker keeps OSM ways whole, so
 * khalidiya.json's centrelines run from x −8.9 km to +12.1 km around a region
 * only 2 km across, and a height field clamps outside its grid and therefore
 * reports flat, perfectly buildable ground out there. Clip the roads — or the
 * returned plots — to the region before using them.
 *
 * Deterministic: the same roads, buildings and seed give byte-identical output,
 * and the result is sorted by position so it is stable to diff.
 */
export function inferPlots(
  roads: RegionRoad[],
  existing: RegionBuilding[],
  slopeAt: (x: number, z: number) => number,
  options?: Partial<PlotOptions>,
): Plot[] {
  const opts = { ...DEFAULT_PLOTS, ...options }
  const frontage = Math.max(4, opts.frontageM)
  const depth = Math.max(3, opts.depthM)
  const setback = Math.max(0, opts.setbackM)
  const clearance = Math.max(0, opts.clearanceM)
  const maxSlope = Math.max(0, opts.maxSlope)

  // Cells a little larger than the biggest plot: small enough that a query
  // touches at most four of them, large enough that none holds a crowd.
  const obstacles = new BucketGrid(Math.max(8, frontage * 1.6))
  const boxes: Obb[] = []

  // Mapped buildings are obstacles from the start. They go in as their bounding
  // box, not their true ring — the honest reason is that an OSM footprint here
  // is a near-rectangle anyway, and its AABB is never smaller than the truth, so
  // the error is on the side of leaving the real building alone.
  for (const b of existing) {
    if (b.ring.length < 3) continue
    let minX = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxZ = -Infinity
    for (const p of b.ring) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.z < minZ) minZ = p.z
      if (p.z > maxZ) maxZ = p.z
    }
    const box = axisAlignedObb(minX, minZ, maxX, maxZ)
    obstacles.insert(minX, minZ, maxX, maxZ, boxes.length)
    boxes.push(box)
  }

  // Every road goes in the segment grid, including the footways nobody fronts
  // onto: you may not build a house across a staircase you cannot address.
  const segGrid = new BucketGrid(Math.max(8, frontage * 1.6))
  const segments: RoadSegment[] = []
  for (let ri = 0; ri < roads.length; ri++) {
    const road = roads[ri]
    const keepOut = Math.max(0.25, road.halfWidth) + clearance
    for (let i = 0; i + 1 < road.pts.length; i++) {
      const a = road.pts[i]
      const b = road.pts[i + 1]
      if (Math.hypot(b.x - a.x, b.z - a.z) < EPS) continue
      const id = segments.length
      segments.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, keepOut, road: ri, index: i })
      segGrid.insert(
        Math.min(a.x, b.x) - keepOut, Math.min(a.z, b.z) - keepOut,
        Math.max(a.x, b.x) + keepOut, Math.max(a.z, b.z) + keepOut,
        id,
      )
    }
  }

  const plots: Plot[] = []
  const hits: number[] = []

  for (let ri = 0; ri < roads.length; ri++) {
    const road = roads[ri]
    if (NO_FRONTAGE.has(road.cls)) continue
    if (road.pts.length < 2) continue

    const cum = cumulative(road.pts)
    const total = cum[cum.length - 1]
    const scale = CLASS_SIZE[road.cls] ?? DEFAULT_SIZE
    const stride = frontage * scale[0]
    const classDepth = depth * scale[1]
    const classSetback = setback * scale[2]
    const halfWidth = Math.max(0.25, road.halfWidth)
    if (total < stride) continue

    // Phase the rhythm per road so parallel streets do not line up in lockstep.
    const start = stride * (0.3 + 0.4 * hash3(ri, -1, 0, opts.seed))

    for (let step = 0; ; step++) {
      const base = start + step * stride
      if (base > total) break
      const d = Math.min(total, Math.max(0, base + stride * SLIDE * (hash3(ri, step, 1, opts.seed) * 2 - 1)))

      const seg = locate(cum, d)
      const a = road.pts[seg]
      const b = road.pts[seg + 1]
      const segLen = cum[seg + 1] - cum[seg]
      if (segLen < EPS) continue
      const t = (d - cum[seg]) / segLen
      const cx = a.x + (b.x - a.x) * t
      const cz = a.z + (b.z - a.z) * t
      const tx = (b.x - a.x) / segLen
      const tz = (b.z - a.z) / segLen

      for (let s = 0; s < 2; s++) {
        // Normal pointing away from the road on this side.
        const side = s === 0 ? 1 : -1
        const nx = tz * side
        const nz = -tx * side

        const ch = s * 8
        const w = stride * (WIDTH_MIN + (WIDTH_MAX - WIDTH_MIN) * hash3(ri, step, ch + 2, opts.seed))
        const dp = classDepth * (1 + DEPTH_JITTER * (hash3(ri, step, ch + 3, opts.seed) * 2 - 1))
        const sb = Math.max(
          // Never set back less than the air the plot demands anyway, or it
          // would collide with the very street it fronts onto.
          clearance,
          classSetback * (1 + SETBACK_JITTER * (hash3(ri, step, ch + 4, opts.seed) * 2 - 1)),
        )

        const off = halfWidth + sb + dp * 0.5
        const box: Obb = {
          cx: cx + nx * off,
          cz: cz + nz * off,
          ux: tx,
          uz: tz,
          hw: w * 0.5,
          hd: dp * 0.5,
        }

        if (tooSteep(box, slopeAt, maxSlope)) continue
        if (hitsObstacle(box, obstacles, boxes, clearance * 0.5, hits)) continue
        if (hitsRoad(box, segGrid, segments, ri, seg, hits)) continue

        const ex = extentX(box)
        const ez = extentZ(box)
        obstacles.insert(box.cx - ex, box.cz - ez, box.cx + ex, box.cz + ez, boxes.length)
        boxes.push(box)

        plots.push({
          x: box.cx,
          z: box.cz,
          // Toward the road, i.e. back along the outward normal.
          facing: Math.atan2(-nx, -nz),
          width: w,
          depth: dp,
          setback: sb,
          roadClass: road.cls,
        })
      }
    }
  }

  // Sorted by position, not by discovery, so two runs diff cleanly and a caller
  // can chunk the list spatially without re-sorting.
  plots.sort((p, q) => p.z - q.z || p.x - q.x)
  return plots
}

/**
 * A house needs a buildable pad, so the corners matter as much as the middle —
 * a plot straddling a wadi lip has a flat centre and a cliff at one end.
 */
function tooSteep(box: Obb, slopeAt: (x: number, z: number) => number, maxSlope: number): boolean {
  if (slopeAt(box.cx, box.cz) > maxSlope) return true
  const vx = -box.uz
  const vz = box.ux
  for (let i = 0; i < 4; i++) {
    const sw = (i & 1) === 0 ? -box.hw : box.hw
    const sd = (i & 2) === 0 ? -box.hd : box.hd
    const x = box.cx + box.ux * sw + vx * sd
    const z = box.cz + box.uz * sw + vz * sd
    if (slopeAt(x, z) > maxSlope) return true
  }
  return false
}

function hitsObstacle(
  box: Obb,
  grid: BucketGrid,
  boxes: Obb[],
  pad: number,
  hits: number[],
): boolean {
  const ex = extentX(box) + pad
  const ez = extentZ(box) + pad
  grid.query(box.cx - ex, box.cz - ez, box.cx + ex, box.cz + ez, hits)
  for (const id of hits) if (obbOverlap(box, boxes[id], pad)) return true
  return false
}

function hitsRoad(
  box: Obb,
  grid: BucketGrid,
  segments: RoadSegment[],
  ownRoad: number,
  ownSeg: number,
  hits: number[],
): boolean {
  const ex = extentX(box)
  const ez = extentZ(box)
  grid.query(box.cx - ex, box.cz - ez, box.cx + ex, box.cz + ez, hits)
  for (const id of hits) {
    const s = segments[id]
    // The segment this plot was measured off, and its two neighbours, are
    // already accounted for by the setback; a bend would otherwise report the
    // plot's own kerb as an intruding road and empty the inside of every corner.
    if (s.road === ownRoad && Math.abs(s.index - ownSeg) <= 1) continue
    if (segmentBoxDistance(box, s.ax, s.az, s.bx, s.bz) < s.keepOut) return true
  }
  return false
}
