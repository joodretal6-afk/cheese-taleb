import { Rng, clamp } from '../engine/math'

/**
 * The mud field the truck drives on.
 *
 * Heights live in a plain float array rather than a physics heightfield
 * collider, because wheels raycast against it analytically. That buys two
 * things a collider cannot: exact bilinear sampling under each tyre, and free
 * runtime deformation — ruts and holes are just writes into the array.
 *
 * Two resolutions are in play on purpose:
 *   - HEIGHT_RES drives physics and the detail normal map. Fine enough that a
 *     stone reads as a distinct bump under one wheel.
 *   - MESH_RES drives the drawn geometry, coarser so a phone can push it. Fine
 *     detail is restored through the normal map rather than through vertices.
 */

/** Arena is a square this many metres on a side. */
export const TERRAIN_SIZE = 50

/** Height samples per axis — 50m / 512 ≈ 9.8cm between samples. */
export const HEIGHT_RES = 512

/** Drawn vertices per axis. */
export const MESH_RES = 256

const HEIGHT_STEP = TERRAIN_SIZE / (HEIGHT_RES - 1)

/**
 * Deepest a rut may cut below the original ground, in metres.
 *
 * Kept shallow deliberately. At 17cm the truck dug a pit under itself faster
 * than it could drive out of one: every frame deepened the hole it was sitting
 * in, and the berm thrown up ahead of the wheel became a wall to climb. The
 * result looked like low grip but was really self-inflicted terrain, which is
 * why adding grip made it worse rather than better.
 */
const MAX_RUT_DEPTH = 0.06

/** Channels in the surface texture the ground shader reads. */
export interface SurfaceSample {
  /** 0 = untouched ground, 1 = fully churned mud. */
  churn: number
  /** 0 = dry, 1 = saturated. Wet mud is darker and shinier. */
  wetness: number
}

export class Terrain {
  readonly size = TERRAIN_SIZE
  readonly res = HEIGHT_RES

  /** Current height at each sample, in metres. */
  readonly heights: Float32Array

  /** Undisturbed reference, so ruts can relax back over time. */
  private readonly restHeights: Float32Array

  /**
   * Per-sample surface state, interleaved as [churn, wetness].
   * Churn darkens the ground and feeds the tyre-dirt pickup.
   */
  readonly surface: Float32Array

  /** Marks the sub-rectangle changed since the last upload, to avoid full re-uploads. */
  private dirtyMinX = Infinity
  private dirtyMinY = Infinity
  private dirtyMaxX = -Infinity
  private dirtyMaxY = -Infinity

  constructor(seed = 20260724) {
    const count = HEIGHT_RES * HEIGHT_RES
    this.heights = new Float32Array(count)
    this.restHeights = new Float32Array(count)
    this.surface = new Float32Array(count * 2)
    this.generate(seed)
  }

  /**
   * Lays down the base ground: broad undulations so the arena is not a table,
   * plus finer ripples that make the suspension chatter at speed.
   */
  private generate(seed: number): void {
    const rng = new Rng(seed)
    const octaves = [
      { scale: 0.035, amplitude: 0.55 },
      { scale: 0.09, amplitude: 0.18 },
      { scale: 0.26, amplitude: 0.055 },
      { scale: 0.7, amplitude: 0.014 },
    ]
    // Random phase per octave keeps successive seeds from sharing a silhouette.
    const phases = octaves.map(() => ({ x: rng.range(0, 1000), y: rng.range(0, 1000) }))

    for (let y = 0; y < HEIGHT_RES; y++) {
      for (let x = 0; x < HEIGHT_RES; x++) {
        const wx = x * HEIGHT_STEP
        const wy = y * HEIGHT_STEP
        let h = 0
        for (let o = 0; o < octaves.length; o++) {
          const { scale, amplitude } = octaves[o]!
          const p = phases[o]!
          h += valueNoise((wx + p.x) * scale, (wy + p.y) * scale) * amplitude
        }
        const index = y * HEIGHT_RES + x
        this.heights[index] = h
        this.restHeights[index] = h
        this.surface[index * 2] = 0

        // Wetness is deliberately patchy rather than uniform. Ground that is
        // muddy everywhere just feels like low grip everywhere; boggy hollows
        // separated by firm ground is what makes reading the terrain matter.
        const damp1 = valueNoise(wx * 0.045 + 91, wy * 0.045 + 17)
        const damp2 = valueNoise(wx * 0.13 + 7, wy * 0.13 + 53)
        const blended = damp1 + damp2 * 0.35
        // Bias low and expand the upper tail, so most ground is firm and the
        // wet patches that do appear are properly wet.
        const wetness = clamp((blended + 0.16) * 1.9, 0, 1) ** 1.7
        this.surface[index * 2 + 1] = wetness
      }
    }
    this.markAllDirty()
  }

  /** Presses a bump into the ground — used to seat stones into the surface. */
  raise(worldX: number, worldZ: number, radius: number, height: number): void {
    this.stamp(worldX, worldZ, radius, (falloff, index) => {
      this.heights[index]! += height * falloff
      this.restHeights[index]! += height * falloff
    })
  }

  /**
   * Carves a rut. Displaced material piles into a lip just outside the contact
   * patch, which is what makes ruts read as ruts rather than as dents.
   */
  deform(worldX: number, worldZ: number, radius: number, depth: number, churn = 1): void {
    const lipRadius = radius * 1.7
    this.stamp(worldX, worldZ, lipRadius, (falloff, index, distance) => {
      if (distance <= radius) {
        const t = 1 - distance / radius
        const sink = depth * t * t
        // Bottom out against the original ground level, not against this
        // call's depth — otherwise a rut can never get deeper than one frame's
        // bite and repeated passes leave no mark.
        const floor = this.restHeights[index]! - MAX_RUT_DEPTH
        this.heights[index] = Math.max(floor, this.heights[index]! - sink)
        this.surface[index * 2] = clamp(this.surface[index * 2]! + churn * t, 0, 1)
      } else {
        // Outside the patch: material thrown up as a berm.
        const t = 1 - (distance - radius) / (lipRadius - radius)
        this.heights[index]! += depth * 0.22 * t * t
        this.surface[index * 2] = clamp(this.surface[index * 2]! + churn * 0.35 * t, 0, 1)
      }
      void falloff
    })
  }

  /** Iterates samples within `radius`, handing the callback a 0..1 falloff. */
  private stamp(
    worldX: number,
    worldZ: number,
    radius: number,
    fn: (falloff: number, index: number, distance: number) => void,
  ): void {
    const gx = worldX / HEIGHT_STEP
    const gy = worldZ / HEIGHT_STEP
    const gr = radius / HEIGHT_STEP
    const minX = Math.max(0, Math.floor(gx - gr))
    const maxX = Math.min(HEIGHT_RES - 1, Math.ceil(gx + gr))
    const minY = Math.max(0, Math.floor(gy - gr))
    const maxY = Math.min(HEIGHT_RES - 1, Math.ceil(gy + gr))
    if (minX > maxX || minY > maxY) return

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = (x - gx) * HEIGHT_STEP
        const dy = (y - gy) * HEIGHT_STEP
        const distance = Math.hypot(dx, dy)
        if (distance > radius) continue
        fn(1 - distance / radius, y * HEIGHT_RES + x, distance)
      }
    }
    this.markDirty(minX, minY, maxX, maxY)
  }

  /** Bilinearly sampled ground height at a world position. */
  heightAt(worldX: number, worldZ: number): number {
    const gx = clamp(worldX / HEIGHT_STEP, 0, HEIGHT_RES - 1.001)
    const gy = clamp(worldZ / HEIGHT_STEP, 0, HEIGHT_RES - 1.001)
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const fx = gx - x0
    const fy = gy - y0
    const row0 = y0 * HEIGHT_RES
    const row1 = row0 + HEIGHT_RES
    const h00 = this.heights[row0 + x0]!
    const h10 = this.heights[row0 + x0 + 1]!
    const h01 = this.heights[row1 + x0]!
    const h11 = this.heights[row1 + x0 + 1]!
    return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy
  }

  /** Surface normal from central differences — used for tyre grip and lighting. */
  normalAt(worldX: number, worldZ: number, out: { x: number; y: number; z: number }): void {
    const e = HEIGHT_STEP
    const hL = this.heightAt(worldX - e, worldZ)
    const hR = this.heightAt(worldX + e, worldZ)
    const hD = this.heightAt(worldX, worldZ - e)
    const hU = this.heightAt(worldX, worldZ + e)
    const nx = hL - hR
    const ny = 2 * e
    const nz = hD - hU
    const len = Math.hypot(nx, ny, nz) || 1
    out.x = nx / len
    out.y = ny / len
    out.z = nz / len
  }

  surfaceAt(worldX: number, worldZ: number, out: SurfaceSample): void {
    const gx = clamp(worldX / HEIGHT_STEP, 0, HEIGHT_RES - 1)
    const gy = clamp(worldZ / HEIGHT_STEP, 0, HEIGHT_RES - 1)
    const index = (Math.round(gy) * HEIGHT_RES + Math.round(gx)) * 2
    out.churn = this.surface[index]!
    out.wetness = this.surface[index + 1]!
  }

  isInside(worldX: number, worldZ: number, margin = 0): boolean {
    return (
      worldX >= margin &&
      worldZ >= margin &&
      worldX <= TERRAIN_SIZE - margin &&
      worldZ <= TERRAIN_SIZE - margin
    )
  }

  private markDirty(minX: number, minY: number, maxX: number, maxY: number): void {
    if (minX < this.dirtyMinX) this.dirtyMinX = minX
    if (minY < this.dirtyMinY) this.dirtyMinY = minY
    if (maxX > this.dirtyMaxX) this.dirtyMaxX = maxX
    if (maxY > this.dirtyMaxY) this.dirtyMaxY = maxY
  }

  markAllDirty(): void {
    this.dirtyMinX = 0
    this.dirtyMinY = 0
    this.dirtyMaxX = HEIGHT_RES - 1
    this.dirtyMaxY = HEIGHT_RES - 1
  }

  /** Returns the changed rectangle and clears it, or null when nothing moved. */
  consumeDirtyRect(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (this.dirtyMaxX < this.dirtyMinX) return null
    const rect = {
      minX: this.dirtyMinX,
      minY: this.dirtyMinY,
      maxX: this.dirtyMaxX,
      maxY: this.dirtyMaxY,
    }
    this.dirtyMinX = Infinity
    this.dirtyMinY = Infinity
    this.dirtyMaxX = -Infinity
    this.dirtyMaxY = -Infinity
    return rect
  }

  gridToWorld(gridIndex: number): number {
    return gridIndex * HEIGHT_STEP
  }

  get heightStep(): number {
    return HEIGHT_STEP
  }
}

/** Smooth value noise. Cheap, tileable enough, and deterministic per integer lattice. */
function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  // Quintic fade: continuous second derivative, so no visible lattice creasing.
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
  const n00 = latticeValue(x0, y0)
  const n10 = latticeValue(x0 + 1, y0)
  const n01 = latticeValue(x0, y0 + 1)
  const n11 = latticeValue(x0 + 1, y0 + 1)
  return (n00 * (1 - ux) + n10 * ux) * (1 - uy) + (n01 * (1 - ux) + n11 * ux) * uy
}

function latticeValue(x: number, y: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5
}
