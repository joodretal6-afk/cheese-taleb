/** Small math/geometry toolkit shared by the whole game. World units are metres. */

export const TAU = Math.PI * 2

export interface Vec2 {
  x: number
  y: number
}

export const vec = (x = 0, y = 0): Vec2 => ({ x, y })

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** Interpolation rate that is stable across frame times. `rate` is per second. */
export const damp = (a: number, b: number, rate: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-rate * dt))

export const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax
  const dy = by - ay
  return dx * dx + dy * dy
}

export const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.sqrt(dist2(ax, ay, bx, by))

/** Shortest signed difference between two angles, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return d
}

export function rotateToward(from: number, to: number, maxStep: number): number {
  const d = angleDelta(from, to)
  return from + clamp(d, -maxStep, maxStep)
}

/** Deterministic PRNG (mulberry32) so a given seed always builds the same match. */
export class Rng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo)
  }

  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1))
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!
  }

  /** Picks an item by relative weight. */
  weighted<T>(items: readonly T[], weightOf: (item: T) => number): T {
    let total = 0
    for (const item of items) total += weightOf(item)
    let roll = this.next() * total
    for (const item of items) {
      roll -= weightOf(item)
      if (roll <= 0) return item
    }
    return items[items.length - 1]!
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance
  }

  /** Uniform point inside a circle. */
  inCircle(cx: number, cy: number, radius: number): Vec2 {
    const a = this.next() * TAU
    const r = Math.sqrt(this.next()) * radius
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }
  }
}

export interface Aabb {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function aabbOf(points: readonly Vec2[]): Aabb {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

export const aabbOverlaps = (a: Aabb, b: Aabb): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

export function pointInPolygon(px: number, py: number, poly: readonly Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

export interface ClosestPoint {
  x: number
  y: number
  /** Squared distance from the query point. */
  d2: number
}

/** Closest point on segment AB to P. */
export function closestPointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): ClosestPoint {
  const abx = bx - ax
  const aby = by - ay
  const lenSq = abx * abx + aby * aby
  const t = lenSq === 0 ? 0 : clamp(((px - ax) * abx + (py - ay) * aby) / lenSq, 0, 1)
  const x = ax + abx * t
  const y = ay + aby * t
  return { x, y, d2: dist2(px, py, x, y) }
}

/**
 * Ray/segment intersection. Returns the ray parameter t (in units of the ray
 * direction's length) or -1 when they do not cross.
 */
export function raySegment(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const sx = bx - ax
  const sy = by - ay
  const denom = dx * sy - dy * sx
  if (Math.abs(denom) < 1e-9) return -1
  const ex = ax - ox
  const ey = ay - oy
  const t = (ex * sy - ey * sx) / denom
  const u = (ex * dy - ey * dx) / denom
  if (t < 0 || u < 0 || u > 1) return -1
  return t
}

export function polygonArea(poly: readonly Vec2[]): number {
  let area = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    area += b.x * a.y - a.x * b.y
  }
  return Math.abs(area) / 2
}

export function polygonCentroid(poly: readonly Vec2[]): Vec2 {
  let cx = 0
  let cy = 0
  let area = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    const cross = b.x * a.y - a.x * b.y
    area += cross
    cx += (a.x + b.x) * cross
    cy += (a.y + b.y) * cross
  }
  if (Math.abs(area) < 1e-6) {
    // Degenerate ring: fall back to the average of the vertices.
    for (const p of poly) {
      cx += p.x
      cy += p.y
    }
    return { x: cx / poly.length, y: cy / poly.length }
  }
  area *= 0.5
  return { x: cx / (6 * area), y: cy / (6 * area) }
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
