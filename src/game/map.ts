import {
  aabbOf,
  closestPointOnSegment,
  dist2,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  raySegment,
  Rng,
  type Aabb,
  type Vec2,
} from '../engine/math'

/** Raw JSON shape produced by tools/fetch-map.mjs. */
interface RawMap {
  version: number
  name: string
  size: number
  origin?: { lat: number; lon: number }
  attribution?: string
  buildings: { p: number[]; h: number; k: string; a: number }[]
  roads: { p: number[]; w: number; k: string }[]
  water: { p: number[] }[]
  green: { p: number[] }[]
}

export type BuildingKind = 'house' | 'warehouse' | 'shop' | 'civic' | 'generic'

export interface Edge {
  ax: number
  ay: number
  bx: number
  by: number
}

export interface Building {
  points: Vec2[]
  edges: Edge[]
  aabb: Aabb
  centroid: Vec2
  height: number
  kind: BuildingKind
  area: number
}

export interface Road {
  points: Vec2[]
  width: number
  kind: 'road' | 'path'
}

export interface Area {
  points: Vec2[]
  aabb: Aabb
}

const GRID_CELL = 24

/**
 * The playable world: static geometry plus the spatial index every runtime
 * query (movement collision, bullet travel, line of sight) goes through.
 */
export class GameMap {
  readonly name: string
  readonly size: number
  readonly attribution: string
  readonly origin: { lat: number; lon: number } | null

  readonly buildings: Building[] = []
  readonly roads: Road[] = []
  readonly water: Area[] = []
  readonly green: Area[] = []

  private grid: number[][] = []
  private gridCols = 0
  private gridRows = 0

  constructor(raw: RawMap) {
    this.name = raw.name
    this.size = raw.size
    this.attribution = raw.attribution ?? ''
    this.origin = raw.origin ?? null

    for (const b of raw.buildings) {
      const points = unflatten(b.p)
      if (points.length < 3) continue
      this.buildings.push({
        points,
        edges: edgesOf(points),
        aabb: aabbOf(points),
        centroid: polygonCentroid(points),
        height: b.h,
        kind: (b.k as BuildingKind) ?? 'generic',
        area: b.a ?? polygonArea(points),
      })
    }

    for (const r of raw.roads) {
      const points = unflatten(r.p)
      if (points.length < 2) continue
      this.roads.push({ points, width: r.w, kind: r.k === 'path' ? 'path' : 'road' })
    }

    for (const w of raw.water) {
      const points = unflatten(w.p)
      if (points.length >= 3) this.water.push({ points, aabb: aabbOf(points) })
    }

    for (const g of raw.green) {
      const points = unflatten(g.p)
      if (points.length >= 3) this.green.push({ points, aabb: aabbOf(points) })
    }

    this.buildGrid()
  }

  private buildGrid(): void {
    this.gridCols = Math.ceil(this.size / GRID_CELL) + 2
    this.gridRows = Math.ceil(this.size / GRID_CELL) + 2
    this.grid = Array.from({ length: this.gridCols * this.gridRows }, () => [])

    this.buildings.forEach((building, index) => {
      const c0 = this.cellX(building.aabb.minX)
      const c1 = this.cellX(building.aabb.maxX)
      const r0 = this.cellY(building.aabb.minY)
      const r1 = this.cellY(building.aabb.maxY)
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          this.grid[r * this.gridCols + c]!.push(index)
        }
      }
    })
  }

  private cellX(x: number): number {
    return Math.min(this.gridCols - 1, Math.max(0, Math.floor(x / GRID_CELL) + 1))
  }

  private cellY(y: number): number {
    return Math.min(this.gridRows - 1, Math.max(0, Math.floor(y / GRID_CELL) + 1))
  }

  /** Building indices whose cells overlap the given world rectangle. */
  private candidates(minX: number, minY: number, maxX: number, maxY: number, out: Set<number>): void {
    out.clear()
    const c0 = this.cellX(minX)
    const c1 = this.cellX(maxX)
    const r0 = this.cellY(minY)
    const r1 = this.cellY(maxY)
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (const index of this.grid[r * this.gridCols + c]!) out.add(index)
      }
    }
  }

  private scratch = new Set<number>()

  /** Buildings potentially overlapping a rectangle — used by the renderer. */
  buildingsInRect(minX: number, minY: number, maxX: number, maxY: number): Building[] {
    this.candidates(minX, minY, maxX, maxY, this.scratch)
    const result: Building[] = []
    for (const index of this.scratch) result.push(this.buildings[index]!)
    return result
  }

  /**
   * Pushes a circle of `radius` out of any wall it overlaps and returns the
   * corrected centre. Runs a couple of relaxation passes so a body wedged into
   * a corner settles instead of jittering between two walls.
   */
  resolveCircle(x: number, y: number, radius: number): Vec2 {
    let px = x
    let py = y

    for (let pass = 0; pass < 3; pass++) {
      let moved = false
      this.candidates(px - radius, py - radius, px + radius, py + radius, this.scratch)

      for (const index of this.scratch) {
        const building = this.buildings[index]!
        const a = building.aabb
        if (px + radius < a.minX || px - radius > a.maxX || py + radius < a.minY || py - radius > a.maxY) {
          continue
        }

        const inside = pointInPolygon(px, py, building.points)
        let bestD2 = Infinity
        let bestX = 0
        let bestY = 0
        for (const e of building.edges) {
          const c = closestPointOnSegment(px, py, e.ax, e.ay, e.bx, e.by)
          if (c.d2 < bestD2) {
            bestD2 = c.d2
            bestX = c.x
            bestY = c.y
          }
        }
        if (bestD2 === Infinity) continue

        const d = Math.sqrt(bestD2)
        if (inside) {
          // Eject through the nearest wall, plus the body radius.
          const nx = d < 1e-6 ? 1 : (px - bestX) / d
          const ny = d < 1e-6 ? 0 : (py - bestY) / d
          px = bestX - nx * radius
          py = bestY - ny * radius
          moved = true
        } else if (d < radius) {
          const nx = d < 1e-6 ? 1 : (px - bestX) / d
          const ny = d < 1e-6 ? 0 : (py - bestY) / d
          px = bestX + nx * radius
          py = bestY + ny * radius
          moved = true
        }
      }

      if (!moved) break
    }

    return { x: px, y: py }
  }

  /** True when a wall stands between the two points — bullets and sight both use this. */
  segmentBlocked(ax: number, ay: number, bx: number, by: number): boolean {
    const dx = bx - ax
    const dy = by - ay
    this.candidates(
      Math.min(ax, bx),
      Math.min(ay, by),
      Math.max(ax, bx),
      Math.max(ay, by),
      this.scratch,
    )
    for (const index of this.scratch) {
      for (const e of this.buildings[index]!.edges) {
        const t = raySegment(ax, ay, dx, dy, e.ax, e.ay, e.bx, e.by)
        if (t >= 0 && t <= 1) return true
      }
    }
    return false
  }

  /**
   * Casts a ray and returns the distance to the first wall, or `maxDistance`
   * when nothing is hit.
   */
  raycastWall(ox: number, oy: number, dirX: number, dirY: number, maxDistance: number): number {
    const bx = ox + dirX * maxDistance
    const by = oy + dirY * maxDistance
    this.candidates(Math.min(ox, bx), Math.min(oy, by), Math.max(ox, bx), Math.max(oy, by), this.scratch)
    let nearest = 1
    for (const index of this.scratch) {
      for (const e of this.buildings[index]!.edges) {
        const t = raySegment(ox, oy, bx - ox, by - oy, e.ax, e.ay, e.bx, e.by)
        if (t >= 0 && t < nearest) nearest = t
      }
    }
    return nearest * maxDistance
  }

  isInsideBuilding(x: number, y: number): boolean {
    this.candidates(x, y, x, y, this.scratch)
    for (const index of this.scratch) {
      if (pointInPolygon(x, y, this.buildings[index]!.points)) return true
    }
    return false
  }

  isInWater(x: number, y: number): boolean {
    for (const area of this.water) {
      const a = area.aabb
      if (x < a.minX || x > a.maxX || y < a.minY || y > a.maxY) continue
      if (pointInPolygon(x, y, area.points)) return true
    }
    return false
  }

  inBounds(x: number, y: number, margin = 0): boolean {
    return x >= margin && y >= margin && x <= this.size - margin && y <= this.size - margin
  }

  /** A walkable spot: inside the map, out of walls and water. */
  findOpenPoint(rng: Rng, near?: Vec2, spread = 60, clearance = 1.2): Vec2 {
    for (let attempt = 0; attempt < 90; attempt++) {
      const p = near
        ? rng.inCircle(near.x, near.y, spread * (0.35 + attempt / 60))
        : { x: rng.range(20, this.size - 20), y: rng.range(20, this.size - 20) }
      if (!this.inBounds(p.x, p.y, 12)) continue
      if (this.isInWater(p.x, p.y)) continue
      const resolved = this.resolveCircle(p.x, p.y, clearance)
      if (dist2(resolved.x, resolved.y, p.x, p.y) < 0.01) return p
    }
    // Every candidate was blocked; fall back to the map centre nudged clear.
    const fallback = near ?? { x: this.size / 2, y: this.size / 2 }
    return this.resolveCircle(fallback.x, fallback.y, clearance)
  }

  /** Spots that read as "loot-worthy": doorstep-adjacent to a building. */
  buildingAdjacentPoints(rng: Rng, count: number): Vec2[] {
    const points: Vec2[] = []
    if (this.buildings.length === 0) return points
    for (let i = 0; i < count * 4 && points.length < count; i++) {
      const building = rng.weighted(this.buildings, (b) => Math.min(400, b.area))
      const edge = rng.pick(building.edges)
      const t = rng.next()
      const ex = edge.ax + (edge.bx - edge.ax) * t
      const ey = edge.ay + (edge.by - edge.ay) * t
      // Step outward along the edge normal, away from the building centre.
      let nx = ex - building.centroid.x
      let ny = ey - building.centroid.y
      const len = Math.hypot(nx, ny) || 1
      nx /= len
      ny /= len
      const offset = rng.range(1.6, 4.5)
      const px = ex + nx * offset
      const py = ey + ny * offset
      if (!this.inBounds(px, py, 8)) continue
      if (this.isInWater(px, py)) continue
      if (this.isInsideBuilding(px, py)) continue
      points.push({ x: px, y: py })
    }
    return points
  }
}

function unflatten(flat: number[]): Vec2[] {
  const points: Vec2[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) points.push({ x: flat[i]!, y: flat[i + 1]! })
  // OSM rings repeat their first node; the game treats rings as implicitly closed.
  if (points.length > 2) {
    const first = points[0]!
    const last = points[points.length - 1]!
    if (Math.abs(first.x - last.x) < 0.01 && Math.abs(first.y - last.y) < 0.01) points.pop()
  }
  return points
}

function edgesOf(points: Vec2[]): Edge[] {
  const edges: Edge[] = []
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y })
  }
  return edges
}

export type { RawMap }
