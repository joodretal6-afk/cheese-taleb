import {
  decodeElevation,
  roadLength,
  type HeightProvider,
  type RegionData,
  type RegionPoint,
  type RegionRoad,
} from './types'

/**
 * Real elevation as a HeightProvider, plus the road cut-and-fill that makes the
 * streets of a real neighbourhood actually drivable.
 *
 * The baked grid is bare terrain: AWS Terrain Tiles / SRTM sees the hill, not
 * the road built across it. Laying a street straight onto that gives a surface
 * that undulates every few metres, which reads as broken suspension rather than
 * as terrain. flattenRoads() re-cuts the grid along each centreline the way a
 * road crew would.
 */

/** Flat verge either side of the carriageway before the blend starts, metres. */
const SHOULDER_M = 1.5
/** Distance over which a flattened road fades back into natural ground. */
const BLEND_M = 6
/** Moving-average window along the centreline, metres. */
const PROFILE_WINDOW_M = 60
/** Steepest along-road gradient a built street is assumed to hold. */
const MAX_GRADE = 0.18
/** Centreline resampling step. Matches the 4 m elevation grid. */
const STEP_M = 4

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return (
    0.5 *
    (2 * p1 +
      (p2 - p0) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (3 * p1 - p0 - 3 * p2 + p3) * t3)
  )
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

/** Resample a polyline into evenly spaced points, roughly `step` metres apart. */
function resamplePath(pts: RegionPoint[], step: number): RegionPoint[] {
  if (pts.length < 2) return []
  const cum = new Float64Array(pts.length)
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
  }
  const total = cum[pts.length - 1]
  if (!(total > 0)) return []

  const n = Math.max(2, Math.round(total / step) + 1)
  const out: RegionPoint[] = new Array(n)
  let seg = 0
  for (let i = 0; i < n; i++) {
    const d = (total * i) / (n - 1)
    while (seg < pts.length - 2 && cum[seg + 1] < d) seg++
    const segLen = cum[seg + 1] - cum[seg]
    const t = segLen > 0 ? (d - cum[seg]) / segLen : 0
    out[i] = {
      x: pts[seg].x + (pts[seg + 1].x - pts[seg].x) * t,
      z: pts[seg].z + (pts[seg + 1].z - pts[seg].z) * t,
    }
  }
  return out
}

/**
 * Boxcar moving average along a profile, with the ends extended rather than
 * shortened — a short cul-de-sac must keep the level of its own two ends, not
 * get dragged toward whatever its middle happens to sit on.
 */
function smoothProfile(h: Float32Array, radius: number) {
  if (radius < 1) return
  const n = h.length
  const pre = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + h[i]

  const win = 2 * radius + 1
  const first = h[0]
  const last = h[n - 1]
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius)
    const b = Math.min(n - 1, i + radius)
    const sum = pre[b + 1] - pre[a] + first * (radius - (i - a)) + last * (radius - (b - i))
    out[i] = sum / win
  }
  h.set(out)
}

/**
 * Project the profile onto |Δh| ≤ maxRise by Gauss–Seidel relaxation.
 *
 * The excess on a violating pair is split between both samples, so the fix is
 * cut-and-fill balanced: the profile keeps its mean and stays near the ground it
 * was measured on instead of the whole road sliding uphill. Sweep direction
 * alternates so neither end is systematically favoured.
 */
function limitGrade(h: Float32Array, maxRise: number) {
  const n = h.length
  for (let pass = 0; pass < 64; pass++) {
    let worst = 0
    const forward = (pass & 1) === 0
    for (let k = 0; k < n - 1; k++) {
      const i = forward ? k : n - 2 - k
      const d = h[i + 1] - h[i]
      const over = Math.abs(d) - maxRise
      if (over <= 0) continue
      if (over > worst) worst = over
      const shift = over * 0.5 * Math.sign(d)
      h[i] += shift
      h[i + 1] -= shift
    }
    if (worst < 1e-3) break
  }
}

export class RegionHeightField implements HeightProvider {
  /** Metres above sea level that y = 0 corresponds to. */
  readonly baseElevationM: number
  /** Full side length of the square region, metres. */
  readonly sizeM: number

  private readonly res: number
  private readonly spacing: number
  private readonly half: number
  private readonly grid: Float32Array

  // Nearest-road scratch, allocated on first flattenRoads() call.
  private bestD: Float32Array | null = null
  private bestH: Float32Array | null = null
  private visit: Int32Array | null = null
  private visitMark = 0

  constructor(region: RegionData) {
    const g = decodeElevation(region.elevation)
    let min = Infinity
    for (let i = 0; i < g.length; i++) if (g[i] < min) min = g[i]
    /*
     * Rebase to the region floor. Absolute elevation here is ~600 m, and putting
     * the whole neighbourhood that far up Y buys nothing while costing float
     * precision in the shadow cascades, the camera depth buffer and every
     * physics ray. The true altitude survives in baseElevationM.
     */
    for (let i = 0; i < g.length; i++) g[i] -= min

    this.grid = g
    this.baseElevationM = min
    this.sizeM = region.sizeM
    this.res = region.elevation.res
    this.spacing = region.sizeM / (region.elevation.res - 1)
    this.half = region.sizeM * 0.5
  }

  // ------------------------------------------------------------------ sampling

  /** Clamped grid fetch. col ↔ +X east, row ↔ +Z north. */
  private at(col: number, row: number): number {
    const c = col < 0 ? 0 : col >= this.res ? this.res - 1 : col
    const r = row < 0 ? 0 : row >= this.res ? this.res - 1 : row
    return this.grid[r * this.res + c]
  }

  /**
   * Ground height, metres, relative to the region floor.
   *
   * Bicubic (Catmull–Rom), not bilinear. The source is one sample per 4 m, and
   * bilinear over that leaves a visible crease at every grid line — on a 25%
   * slope you feel each one through the suspension as a series of small steps.
   * Catmull–Rom is C¹ across cells, so the ride is smooth and the surface
   * normals used for shading and for tyre grip stay continuous.
   */
  heightAt(wx: number, wz: number): number {
    const gx = (wx + this.half) / this.spacing
    const gz = (wz + this.half) / this.spacing
    const cx = Math.floor(gx)
    const cz = Math.floor(gz)
    const tx = gx - cx
    const tz = gz - cz

    const r0 = catmullRom(this.at(cx - 1, cz - 1), this.at(cx, cz - 1), this.at(cx + 1, cz - 1), this.at(cx + 2, cz - 1), tx)
    const r1 = catmullRom(this.at(cx - 1, cz), this.at(cx, cz), this.at(cx + 1, cz), this.at(cx + 2, cz), tx)
    const r2 = catmullRom(this.at(cx - 1, cz + 1), this.at(cx, cz + 1), this.at(cx + 1, cz + 1), this.at(cx + 2, cz + 1), tx)
    const r3 = catmullRom(this.at(cx - 1, cz + 2), this.at(cx, cz + 2), this.at(cx + 1, cz + 2), this.at(cx + 2, cz + 2), tx)
    return catmullRom(r0, r1, r2, r3, tz)
  }

  /** Gradient magnitude, dimensionless — 0.25 is a 25% slope. */
  slopeAt(wx: number, wz: number): number {
    // A full grid cell apart: a shorter baseline just measures the interpolant's
    // own curvature rather than the terrain.
    const e = this.spacing * 0.5
    const dx = (this.heightAt(wx + e, wz) - this.heightAt(wx - e, wz)) / (2 * e)
    const dz = (this.heightAt(wx, wz + e) - this.heightAt(wx, wz - e)) / (2 * e)
    return Math.hypot(dx, dz)
  }

  range(): { min: number; max: number } {
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < this.grid.length; i++) {
      const v = this.grid[i]
      if (v < min) min = v
      if (v > max) max = v
    }
    return { min, max }
  }

  // ------------------------------------------------------------ road flattening

  /**
   * Cut and fill the height grid along every road centreline.
   *
   * Honest limitation: 4–30 m source data knows the shape of the hill and
   * nothing else. There are no kerbs, no ditches, no camber, no embankments and
   * no bridges in here — a flyover becomes a cutting through the ground it flies
   * over. This reproduces the *grade* of a street, not its construction.
   *
   * The grade cap is enforced per road, so a junction where a wider street
   * imposes its own level can still leave a short over-steep stretch on the
   * minor road. That is also what happens on the ground.
   */
  flattenRoads(roads: RegionRoad[]): void {
    this.ensureScratch()
    // Wider roads last: at a junction the bigger street holds its level and the
    // side road is the one that bends to meet it. Length breaks ties for the
    // same reason — a long through-road outranks a short spur of equal width.
    const order = roads
      .slice()
      .sort((a, b) => a.halfWidth - b.halfWidth || roadLength(a) - roadLength(b))
    for (const road of order) this.flattenRoad(road)
  }

  private ensureScratch() {
    if (this.bestD) return
    const n = this.res * this.res
    this.bestD = new Float32Array(n)
    this.bestH = new Float32Array(n)
    this.visit = new Int32Array(n)
  }

  private flattenRoad(road: RegionRoad) {
    const path = resamplePath(road.pts, STEP_M)
    const n = path.length
    if (n < 2) return

    // Sample the terrain the road is laid on. Points outside the region clamp to
    // the edge; only in-grid cells are ever written, so those samples just carry
    // the profile across the boundary without inventing a level.
    const prof = new Float32Array(n)
    for (let i = 0; i < n; i++) prof[i] = this.heightAt(path[i].x, path[i].z)

    const step = Math.hypot(path[1].x - path[0].x, path[1].z - path[0].z)
    // Wide enough to erase terrain noise, narrow enough that the hill is still a
    // hill: a 60 m window passes any real gradient the road actually climbs.
    smoothProfile(prof, Math.round(PROFILE_WINDOW_M / step / 2))
    limitGrade(prof, MAX_GRADE * step)

    const bestD = this.bestD!
    const bestH = this.bestH!
    const visit = this.visit!
    const mark = ++this.visitMark

    const core = road.halfWidth + SHOULDER_M
    const reach = core + BLEND_M
    const res = this.res

    let c0 = res
    let c1 = -1
    let r0 = res
    let r1 = -1

    for (let s = 0; s < n - 1; s++) {
      const ax = path[s].x
      const az = path[s].z
      const ex = path[s + 1].x - ax
      const ez = path[s + 1].z - az
      const len2 = ex * ex + ez * ez
      if (len2 <= 0) continue

      const lo = Math.max(0, Math.floor((Math.min(ax, ax + ex) - reach + this.half) / this.spacing))
      const hi = Math.min(res - 1, Math.ceil((Math.max(ax, ax + ex) + reach + this.half) / this.spacing))
      const lz = Math.max(0, Math.floor((Math.min(az, az + ez) - reach + this.half) / this.spacing))
      const hz = Math.min(res - 1, Math.ceil((Math.max(az, az + ez) + reach + this.half) / this.spacing))
      if (lo > hi || lz > hz) continue

      for (let row = lz; row <= hz; row++) {
        const wz = row * this.spacing - this.half
        for (let col = lo; col <= hi; col++) {
          const wx = col * this.spacing - this.half
          let t = ((wx - ax) * ex + (wz - az) * ez) / len2
          t = t < 0 ? 0 : t > 1 ? 1 : t
          const d = Math.hypot(wx - (ax + ex * t), wz - (az + ez * t))
          if (d >= reach) continue

          const i = row * res + col
          if (visit[i] === mark && bestD[i] <= d) continue
          visit[i] = mark
          bestD[i] = d
          bestH[i] = prof[s] + (prof[s + 1] - prof[s]) * t

          if (col < c0) c0 = col
          if (col > c1) c1 = col
          if (row < r0) r0 = row
          if (row > r1) r1 = row
        }
      }
    }

    if (c1 < c0 || r1 < r0) return

    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const i = row * res + col
        if (visit[i] !== mark) continue
        const d = bestD[i]
        // Full carriageway plus shoulder, then a smooth ramp back to natural
        // ground so the verge is a slope and not a cliff.
        const w = d <= core ? 1 : smoothstep(1 - (d - core) / BLEND_M)
        this.grid[i] += (bestH[i] - this.grid[i]) * w
      }
    }
  }
}
