import type { RegionPoint, RegionRoad, RoadClass } from './types'

/**
 * Road network geometry.
 *
 * Turns 155 OSM centrelines (87.8 km) into one indexed mesh of ribbons that
 * hug the graded terrain, grouped by highway class so the scene draws the whole
 * network with a handful of materials instead of 155 draw calls.
 *
 * Everything here is a pure function over plain data and typed arrays: no
 * Babylon types, no scene, so it runs and can be asserted on in bare Node.
 */

export interface RoadMeshOptions {
  /** Maximum gap between ribbon cross-sections, metres. */
  step: number
  /** Metres added to the sampled ground height, to stop z-fighting. */
  lift: number
  /** Metres of hard shoulder added to each side beyond the carriageway. */
  shoulder: number
}

export const DEFAULT_ROAD_MESH: RoadMeshOptions = {
  step: 4,
  // The rendered ground mesh is far coarser than our 4 m sampling (a 2 km
  // region at ultra quality is ~3 m per quad, at low quality ~10 m), so a road
  // sitting exactly on the height function still sinks into the drawn hillside
  // on convex ground. 12 cm clears that everywhere in Khalidiya without
  // reading as a kerb from the driver's seat.
  lift: 0.12,
  shoulder: 0.35,
}

export interface RoadGeometry {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  indices: Uint32Array
  groups: { cls: RoadClass; indexStart: number; indexCount: number }[]
}

/**
 * Draw order for the class groups, coarsest first, matching RoadClass in
 * types.ts. Fixed rather than discovery-ordered so two bakes of the same region
 * produce byte-identical group tables.
 */
const CLASS_ORDER: RoadClass[] = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street', 'service',
  'track', 'pedestrian', 'footway', 'path', 'steps',
]

/**
 * Mitre offsets blow up as a join approaches a hairpin: the factor is
 * 1/cos(theta/2), which is unbounded at theta = 180°. Capping at 3 means a turn
 * sharper than ~141° stops widening and simply bevels instead — the outside
 * edge pinches slightly, which nobody sees, whereas an uncapped mitre fires a
 * single vertex kilometres off the map and takes the bounding box with it.
 */
const MITRE_CAP = 3

/** Segments shorter than this are noise in the OSM geometry, not corners. */
const EPS = 1e-4

/**
 * Count the cross-sections a centreline needs: every original vertex is kept
 * (so corners survive intact) and each segment is subdivided until no gap
 * exceeds `step`. Pure counting pass so the output array is sized exactly.
 */
function countSamples(pts: RegionPoint[], step: number): number {
  let n = 1
  for (let i = 0; i + 1 < pts.length; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z)
    if (len < EPS) continue
    n += Math.max(1, Math.ceil(len / step))
  }
  return n
}

/**
 * Resample a centreline into interleaved [x, z, x, z, ...].
 *
 * Uniform resampling alone would round off bends whose vertices fall between
 * samples, so this subdivides in place instead: original vertices are exact,
 * long straights gain intermediate cross-sections so they follow the terrain
 * underneath rather than spanning it with one flat quad.
 */
function resampleCentreline(pts: RegionPoint[], step: number, n: number): Float32Array {
  const out = new Float32Array(n * 2)
  out[0] = pts[0].x
  out[1] = pts[0].z
  let o = 2
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i].x
    const az = pts[i].z
    const dx = pts[i + 1].x - ax
    const dz = pts[i + 1].z - az
    const len = Math.hypot(dx, dz)
    if (len < EPS) continue
    const div = Math.max(1, Math.ceil(len / step))
    for (let k = 1; k <= div; k++) {
      const t = k / div
      out[o++] = ax + dx * t
      out[o++] = az + dz * t
    }
  }
  return out
}

/**
 * Write one ribbon into the shared buffers.
 *
 * Cross-section i emits two vertices: index 0 is the +perp side (u = 1), index
 * 1 is the −perp side (u = 0), where perp = (dir.z, −dir.x) — that is +X when
 * heading +Z, so u runs east exactly like Terrain's ground UVs.
 */
function writeRibbon(
  line: Float32Array,
  width: number,
  tile: number,
  height: (x: number, z: number) => number,
  lift: number,
  positions: Float32Array,
  uvs: Float32Array,
  indices: Uint32Array,
  vertBase: number,
  idxBase: number,
): void {
  const n = line.length / 2
  let dist = 0
  let px = 0
  let pz = 0

  for (let i = 0; i < n; i++) {
    const cx = line[i * 2]
    const cz = line[i * 2 + 1]

    if (i > 0) dist += Math.hypot(cx - px, cz - pz)
    px = cx
    pz = cz

    // Incoming and outgoing unit directions; endpoints reuse their one segment.
    let inx = 0
    let inz = 0
    if (i > 0) {
      inx = cx - line[i * 2 - 2]
      inz = cz - line[i * 2 - 1]
      const l = Math.hypot(inx, inz) || 1
      inx /= l
      inz /= l
    }
    let outx = 0
    let outz = 0
    if (i + 1 < n) {
      outx = line[i * 2 + 2] - cx
      outz = line[i * 2 + 3] - cz
      const l = Math.hypot(outx, outz) || 1
      outx /= l
      outz /= l
    }
    if (i === 0) {
      inx = outx
      inz = outz
    } else if (i + 1 === n) {
      outx = inx
      outz = inz
    }

    // Bisector of the two directions. Offsetting along its perpendicular is
    // what keeps the ribbon closed at bends; a per-segment perpendicular would
    // tear a gap on the outside of every corner.
    let mx = inx + outx
    let mz = inz + outz
    const ml = Math.hypot(mx, mz)
    let scale = 1
    if (ml < 1e-6) {
      // Exact 180° doubling-back: no bisector exists. Keep the incoming
      // direction and let the join pinch rather than emit NaNs.
      mx = inx
      mz = inz
    } else {
      mx /= ml
      mz /= ml
      // dot(in, bisector) = cos(theta/2) for turn angle theta.
      const c = inx * mx + inz * mz
      scale = c > 1 / MITRE_CAP ? 1 / c : MITRE_CAP
    }

    const ox = mz * width * scale
    const oz = -mx * width * scale

    const v = vertBase + i * 2
    const rx = cx + ox
    const rz = cz + oz
    const lx = cx - ox
    const lz = cz - oz

    // Height per edge vertex, not per centre: a road crossing a slope sideways
    // must tilt with it, and a single centre sample would leave it flat.
    positions[v * 3] = rx
    positions[v * 3 + 1] = height(rx, rz) + lift
    positions[v * 3 + 2] = rz
    positions[v * 3 + 3] = lx
    positions[v * 3 + 4] = height(lx, lz) + lift
    positions[v * 3 + 5] = lz

    const tv = dist / tile
    uvs[v * 2] = 1
    uvs[v * 2 + 1] = tv
    uvs[v * 2 + 2] = 0
    uvs[v * 2 + 3] = tv
  }

  // Winding: this is the exact quad order Terrain.buildGeometry uses — for the
  // reference quad (−perp, +perp) × (i, i+1) that is (a, b, c) then (b, d, c).
  // Babylon is left-handed and the opposite order leaves the surface
  // back-facing, i.e. invisible from above, which has cost this project hours
  // before. Do not "tidy" these six lines.
  let o = idxBase
  for (let i = 0; i + 1 < n; i++) {
    const b = vertBase + i * 2
    indices[o++] = b + 1
    indices[o++] = b
    indices[o++] = b + 3
    indices[o++] = b
    indices[o++] = b + 2
    indices[o++] = b + 3
  }
}

/**
 * Face normals accumulated onto their vertices, area-weighted by using the
 * unnormalised cross product.
 *
 * The cross is taken as (p0 − p1) × (p2 − p1), which is Babylon's own
 * ComputeNormals convention and yields +Y for the winding emitted above.
 */
function accumulateNormals(
  positions: Float32Array,
  indices: Uint32Array,
  normals: Float32Array,
): void {
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3
    const b = indices[i + 1] * 3
    const c = indices[i + 2] * 3

    const ux = positions[a] - positions[b]
    const uy = positions[a + 1] - positions[b + 1]
    const uz = positions[a + 2] - positions[b + 2]
    const vx = positions[c] - positions[b]
    const vy = positions[c + 1] - positions[b + 1]
    const vz = positions[c + 2] - positions[b + 2]

    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx

    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz
  }

  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2])
    if (l < 1e-9) {
      // Degenerate ribbon (a road folded exactly back on itself). Point it up
      // so it shades like flat ground instead of going black.
      normals[i] = 0
      normals[i + 1] = 1
      normals[i + 2] = 0
    } else {
      normals[i] /= l
      normals[i + 1] /= l
      normals[i + 2] /= l
    }
  }
}

/**
 * Build the whole road network as one indexed mesh.
 *
 * `height` is expected to be MudField's ground height — the single source of
 * truth every other system samples — so the ribbons sit on the same surface the
 * vehicle drives on. Road coordinates are already local metres; nothing is
 * re-projected here.
 */
export function buildRoadGeometry(
  roads: RegionRoad[],
  height: (x: number, z: number) => number,
  options?: Partial<RoadMeshOptions>,
): RoadGeometry {
  const opts = { ...DEFAULT_ROAD_MESH, ...options }
  const step = opts.step > EPS ? opts.step : DEFAULT_ROAD_MESH.step
  const shoulder = Math.max(0, opts.shoulder)

  // Resample once, up front, so the output buffers can be allocated exactly.
  // One Float32Array per road, never one object per vertex.
  const lines: Float32Array[] = []
  const lineClass: RoadClass[] = []
  const lineWidth: number[] = []
  let vertCount = 0
  let indexCount = 0

  for (const cls of CLASS_ORDER) {
    for (const road of roads) {
      if (road.cls !== cls) continue
      if (road.pts.length < 2) continue
      const n = countSamples(road.pts, step)
      if (n < 2) continue // every segment was degenerate
      lines.push(resampleCentreline(road.pts, step, n))
      lineClass.push(cls)
      lineWidth.push(Math.max(0.25, road.halfWidth) + shoulder)
      vertCount += n * 2
      indexCount += (n - 1) * 6
    }
  }

  const positions = new Float32Array(vertCount * 3)
  const normals = new Float32Array(vertCount * 3)
  const uvs = new Float32Array(vertCount * 2)
  const indices = new Uint32Array(indexCount)
  const groups: RoadGeometry['groups'] = []

  let vertBase = 0
  let idxBase = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const width = lineWidth[i]
    const n = line.length / 2

    // U spans the full carriageway, so V is measured in road-widths: one
    // texture tile is one square of asphalt whatever the class, and a 900 m
    // straight repeats the texture instead of smearing it end to end.
    writeRibbon(line, width, width * 2, height, opts.lift, positions, uvs, indices, vertBase, idxBase)

    const cls = lineClass[i]
    const count = (n - 1) * 6
    const last = groups[groups.length - 1]
    if (last && last.cls === cls) last.indexCount += count
    else groups.push({ cls, indexStart: idxBase, indexCount: count })

    vertBase += n * 2
    idxBase += count
  }

  accumulateNormals(positions, indices, normals)

  return { positions, normals, uvs, indices, groups }
}
