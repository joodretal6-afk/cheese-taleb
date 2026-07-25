import type { RegionPoint } from './types'
import type { GeneratedBuilding } from './buildingMesh'

/**
 * Buildings as solids.
 *
 * The rendered buildings are one merged mesh, which is what keeps several
 * thousand houses at two draw calls — but a merged mesh cannot tell anyone
 * where one house ends and the next begins. So collision is derived from the
 * footprints instead, once, at load: an oriented box per building, handed to
 * Rapier for the truck and to the character controller for the player on foot.
 *
 * An oriented box rather than the true ring, because every footprint in this
 * region IS a rectangle — the generated ones by construction, and the one
 * surveyed OSM building to within a few centimetres. Boxing an L-shaped
 * building would over-claim its inner corner; there are none here, and the code
 * says so rather than pretending to a generality it does not have.
 */

export interface BuildingBox {
  /** Centre of the footprint, world metres. */
  cx: number
  cz: number
  /** Half extents along the box's own axes, metres. */
  hx: number
  hz: number
  /** Rotation about +Y, radians: the angle of the hx axis. */
  rot: number
  /** Ground level the walls stand on, engine metres. */
  baseY: number
  /** Wall height above baseY, metres. */
  height: number
}

/**
 * Minimum-area oriented bounding box of a footprint, by rotating calipers over
 * the edge directions.
 *
 * The minimum-area rectangle around a convex polygon always has a side flush
 * with one of its edges, so trying each edge as the axis is exhaustive rather
 * than a heuristic. For an actual rectangle it returns that rectangle exactly.
 */
function orientedBox(ring: RegionPoint[]): { cx: number; cz: number; hx: number; hz: number; rot: number } | null {
  if (ring.length < 3) return null

  let best: { area: number; cx: number; cz: number; hx: number; hz: number; rot: number } | null = null

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const ex = b.x - a.x
    const ez = b.z - a.z
    const len = Math.hypot(ex, ez)
    if (len < 1e-6) continue
    const ux = ex / len
    const uz = ez / len
    // Perpendicular in the same frame the rest of the engine uses.
    const vx = -uz
    const vz = ux

    let minU = Infinity
    let maxU = -Infinity
    let minV = Infinity
    let maxV = -Infinity
    for (const p of ring) {
      const u = p.x * ux + p.z * uz
      const v = p.x * vx + p.z * vz
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }

    const w = maxU - minU
    const d = maxV - minV
    const area = w * d
    if (best && area >= best.area) continue

    const cu = (minU + maxU) * 0.5
    const cv = (minV + maxV) * 0.5
    best = {
      area,
      // Back out of the (u, v) frame into world space.
      cx: cu * ux + cv * vx,
      cz: cu * uz + cv * vz,
      hx: w * 0.5,
      hz: d * 0.5,
      // atan2(x, z) is the engine's yaw convention throughout.
      rot: Math.atan2(ux, uz),
    }
  }

  if (!best || !(best.hx > 0.05) || !(best.hz > 0.05)) return null
  return { cx: best.cx, cz: best.cz, hx: best.hx, hz: best.hz, rot: best.rot }
}

/**
 * Turn footprints into collision boxes standing on the ground.
 *
 * `height` must be the same ground every other system samples, so the boxes sit
 * exactly where the walls were drawn. The base is taken at the LOWEST corner,
 * matching buildingMesh's founding rule — take the average instead and the box
 * floats above the downhill corner of every house on a slope, leaving a gap the
 * truck can nose into.
 */
export function buildingBoxes(
  buildings: GeneratedBuilding[],
  height: (x: number, z: number) => number,
): BuildingBox[] {
  const out: BuildingBox[] = []
  for (const b of buildings) {
    const box = orientedBox(b.ring)
    if (!box) continue
    let lo = Infinity
    for (const p of b.ring) {
      const g = height(p.x, p.z)
      if (g < lo) lo = g
    }
    if (!Number.isFinite(lo)) continue
    out.push({ ...box, baseY: lo, height: Math.max(2, b.height) })
  }
  return out
}
