import {
  Color3,
  Mesh,
  Scene,
  StandardMaterial,
  VertexData,
} from '@babylonjs/core'
import type { PhxMap } from '../map/phxmap'

export type BrushMode = 'raise' | 'lower' | 'smooth' | 'flatten'

/** Colour ramp used to read elevation at a glance while sculpting. */
const RAMP: { at: number; c: [number, number, number] }[] = [
  { at: 0.0, c: [0.18, 0.32, 0.5] }, // water/low — blue
  { at: 0.12, c: [0.76, 0.7, 0.5] }, // beach — sand
  { at: 0.28, c: [0.36, 0.52, 0.26] }, // grass
  { at: 0.6, c: [0.4, 0.34, 0.26] }, // rock/dirt
  { at: 0.85, c: [0.55, 0.55, 0.57] }, // stone
  { at: 1.0, c: [0.96, 0.96, 0.98] }, // snow
]

function rampColor(t: number, out: [number, number, number]): void {
  const x = Math.max(0, Math.min(1, t))
  for (let i = 1; i < RAMP.length; i++) {
    if (x <= RAMP[i].at) {
      const a = RAMP[i - 1]
      const b = RAMP[i]
      const k = (x - a.at) / (b.at - a.at || 1)
      out[0] = a.c[0] + (b.c[0] - a.c[0]) * k
      out[1] = a.c[1] + (b.c[1] - a.c[1]) * k
      out[2] = a.c[2] + (b.c[2] - a.c[2]) * k
      return
    }
  }
  out[0] = RAMP[RAMP.length - 1].c[0]
  out[1] = RAMP[RAMP.length - 1].c[1]
  out[2] = RAMP[RAMP.length - 1].c[2]
}

/**
 * The editable terrain: a square heightfield rendered as one mesh, sculpted by
 * brush strokes in world space. Positions/normals/colours are rebuilt from the
 * heightfield after each stroke.
 */
export class Terrain {
  readonly mesh: Mesh
  readonly grid: number
  readonly worldSize: number
  private readonly heights: Float32Array
  private readonly positions: Float32Array
  private readonly colors: Float32Array
  private readonly indices: Uint32Array
  private readonly normals: Float32Array
  private readonly cell: number

  constructor(scene: Scene, map: PhxMap) {
    this.grid = map.meta.grid
    this.worldSize = map.meta.worldSizeMeters
    this.cell = this.worldSize / (this.grid - 1)

    const n = this.grid * this.grid
    this.heights = Float32Array.from(map.heights.length === n ? map.heights : new Array(n).fill(0))
    this.positions = new Float32Array(n * 3)
    this.colors = new Float32Array(n * 4)
    this.normals = new Float32Array(n * 3)
    this.indices = new Uint32Array((this.grid - 1) * (this.grid - 1) * 6)

    this.buildIndices()

    this.mesh = new Mesh('terrain', scene)
    const mat = new StandardMaterial('terrainMat', scene)
    mat.specularColor = new Color3(0.03, 0.03, 0.03)
    this.mesh.material = mat
    this.mesh.useVertexColors = true

    this.rebuildAll()
  }

  private buildIndices(): void {
    let o = 0
    const g = this.grid
    for (let z = 0; z < g - 1; z++) {
      for (let x = 0; x < g - 1; x++) {
        const a = z * g + x
        const b = a + 1
        const c = a + g
        const d = c + 1
        this.indices[o++] = a
        this.indices[o++] = b
        this.indices[o++] = c
        this.indices[o++] = b
        this.indices[o++] = d
        this.indices[o++] = c
      }
    }
  }

  /** World X/Z of grid vertex (ix, iz), centred on the origin. */
  private worldX(ix: number): number {
    return ix * this.cell - this.worldSize / 2
  }
  private worldZ(iz: number): number {
    return iz * this.cell - this.worldSize / 2
  }

  private rebuildPositions(): void {
    const g = this.grid
    for (let iz = 0; iz < g; iz++) {
      for (let ix = 0; ix < g; ix++) {
        const i = iz * g + ix
        this.positions[i * 3] = this.worldX(ix)
        this.positions[i * 3 + 1] = this.heights[i]
        this.positions[i * 3 + 2] = this.worldZ(iz)
      }
    }
  }

  private rebuildColors(): void {
    // Normalise height across the current range for the colour ramp.
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < this.heights.length; i++) {
      if (this.heights[i] < min) min = this.heights[i]
      if (this.heights[i] > max) max = this.heights[i]
    }
    const span = Math.max(1e-3, max - min)
    const c: [number, number, number] = [0, 0, 0]
    for (let i = 0; i < this.heights.length; i++) {
      rampColor((this.heights[i] - min) / span, c)
      this.colors[i * 4] = c[0]
      this.colors[i * 4 + 1] = c[1]
      this.colors[i * 4 + 2] = c[2]
      this.colors[i * 4 + 3] = 1
    }
  }

  private rebuildAll(): void {
    this.rebuildPositions()
    this.rebuildColors()
    VertexData.ComputeNormals(this.positions, this.indices, this.normals)
    const data = new VertexData()
    data.positions = this.positions as unknown as number[]
    data.normals = this.normals as unknown as number[]
    data.colors = this.colors as unknown as number[]
    data.indices = this.indices as unknown as number[]
    data.applyToMesh(this.mesh, true)
  }

  /** Refresh just the buffers that a stroke changed. */
  private refreshMesh(): void {
    this.rebuildPositions()
    this.rebuildColors()
    VertexData.ComputeNormals(this.positions, this.indices, this.normals)
    this.mesh.updateVerticesData('position', this.positions as unknown as number[])
    this.mesh.updateVerticesData('normal', this.normals as unknown as number[])
    this.mesh.updateVerticesData('color', this.colors as unknown as number[])
  }

  /**
   * Apply one brush dab centred at world (wx, wz).
   * @param radius brush radius in metres
   * @param strength metres per dab at the centre (falls off to the edge)
   * @param flattenTarget height to pull toward in 'flatten' mode
   */
  sculpt(wx: number, wz: number, mode: BrushMode, radius: number, strength: number, flattenTarget = 0): void {
    const g = this.grid
    const cx = (wx + this.worldSize / 2) / this.cell
    const cz = (wz + this.worldSize / 2) / this.cell
    const r = radius / this.cell
    const x0 = Math.max(0, Math.floor(cx - r))
    const x1 = Math.min(g - 1, Math.ceil(cx + r))
    const z0 = Math.max(0, Math.floor(cz - r))
    const z1 = Math.min(g - 1, Math.ceil(cz + r))

    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const dx = ix - cx
        const dz = iz - cz
        const d = Math.sqrt(dx * dx + dz * dz) / (r || 1)
        if (d > 1) continue
        // Smooth cosine falloff.
        const fall = 0.5 + 0.5 * Math.cos(Math.min(1, d) * Math.PI)
        const i = iz * g + ix
        switch (mode) {
          case 'raise':
            this.heights[i] += strength * fall
            break
          case 'lower':
            this.heights[i] -= strength * fall
            break
          case 'flatten':
            this.heights[i] += (flattenTarget - this.heights[i]) * fall * 0.5
            break
          case 'smooth': {
            const avg = this.neighbourAverage(ix, iz)
            this.heights[i] += (avg - this.heights[i]) * fall * 0.6
            break
          }
        }
      }
    }
    this.refreshMesh()
  }

  private neighbourAverage(ix: number, iz: number): number {
    const g = this.grid
    let sum = 0
    let count = 0
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = ix + dx
        const z = iz + dz
        if (x < 0 || z < 0 || x >= g || z >= g) continue
        sum += this.heights[z * g + x]
        count++
      }
    }
    return sum / count
  }

  /** Sample terrain height at world (wx, wz) via bilinear interpolation. */
  heightAt(wx: number, wz: number): number {
    const g = this.grid
    const fx = Math.max(0, Math.min(g - 1, (wx + this.worldSize / 2) / this.cell))
    const fz = Math.max(0, Math.min(g - 1, (wz + this.worldSize / 2) / this.cell))
    const x0 = Math.floor(fx)
    const z0 = Math.floor(fz)
    const x1 = Math.min(g - 1, x0 + 1)
    const z1 = Math.min(g - 1, z0 + 1)
    const tx = fx - x0
    const tz = fz - z0
    const h00 = this.heights[z0 * g + x0]
    const h10 = this.heights[z0 * g + x1]
    const h01 = this.heights[z1 * g + x0]
    const h11 = this.heights[z1 * g + x1]
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
  }

  /** Extract the current heightfield back into a plain array for saving. */
  exportHeights(): number[] {
    return Array.from(this.heights)
  }

  dispose(): void {
    this.mesh.material?.dispose()
    this.mesh.dispose()
  }
}
