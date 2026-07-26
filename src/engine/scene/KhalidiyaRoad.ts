import {
  Color3,
  MeshBuilder,
  StandardMaterial,
  Vector3,
  type AbstractMesh,
  type Mesh,
  type Scene,
} from '@babylonjs/core'

/**
 * The Khalidiya road scene.
 *
 * A recreation of the reference photo: a dual carriageway of black asphalt with
 * white dashed lanes and yellow edge lines, a raised concrete median running its
 * full length with lamp poles, steel guardrails down both sides, sandy desert
 * ground, and sand-coloured houses set back in the distance — under the sim's
 * clear desert sky.
 *
 * It is a self-contained overlay: it recolours the ground to desert through the
 * terrain's tint, drapes the road ribbons over whatever the field is doing, and
 * parks the player at the near end looking down the road (the photo's view). A
 * clear() takes it all back out.
 */

interface SimLike {
  scene: Scene
  field: { surfaceHeight(x: number, z: number): number; worldSize: number }
  terrain: { tintGround(kind: 'dirt' | 'mud' | 'rock' | 'grass', r: number, g: number, b: number): void }
  vehicle?: { reset(at?: Vector3, yaw?: number): void }
}

// Colours sampled from the reference photo.
const C = {
  asphalt: new Color3(0.13, 0.13, 0.14),
  white: new Color3(0.86, 0.86, 0.83),
  yellow: new Color3(0.85, 0.63, 0.11),
  concrete: new Color3(0.72, 0.68, 0.6),
  metal: new Color3(0.62, 0.64, 0.67),
  pole: new Color3(0.32, 0.33, 0.35),
  sand: [0.78, 0.68, 0.48] as [number, number, number],
  sandDark: [0.72, 0.62, 0.43] as [number, number, number],
  house: [
    new Color3(0.82, 0.71, 0.5),
    new Color3(0.76, 0.65, 0.46),
    new Color3(0.86, 0.76, 0.56),
    new Color3(0.7, 0.6, 0.44),
  ],
}

// Road geometry (metres).
const LANES = 3
const LANE_W = 2.4
const CARRIAGE_W = LANES * LANE_W // 7.2
const MEDIAN_W = 1.8
const HALF_LEN = 160 // road runs from -160 to +160 in z
const STEP = 4 // ribbon sampling step
/** Centre offset of each carriageway from the road centreline. */
const CX = MEDIAN_W / 2 + CARRIAGE_W / 2

export class KhalidiyaRoad {
  private readonly sim: SimLike
  private readonly scene: Scene
  private readonly meshes: AbstractMesh[] = []
  private readonly mats: StandardMaterial[] = []
  built = false

  constructor(sim: SimLike) {
    this.sim = sim
    this.scene = sim.scene
  }

  private mat(name: string, color: Color3, opts?: { spec?: number; unlit?: boolean }): StandardMaterial {
    const m = new StandardMaterial(`khal_${name}`, this.scene)
    m.diffuseColor = color
    m.specularColor = new Color3(opts?.spec ?? 0.05, opts?.spec ?? 0.05, opts?.spec ?? 0.05)
    if (opts?.unlit) m.emissiveColor = color.scale(0.5)
    this.mats.push(m)
    return m
  }

  private y(x: number, z: number): number {
    return this.sim.field.surfaceHeight(x, z)
  }

  /**
   * A flat-across, terrain-following ribbon centred on x, of the given width,
   * lifted `lift` above the ground. Used for the asphalt, the paint and the
   * concrete.
   */
  private ribbon(name: string, centerX: number, width: number, lift: number, mat: StandardMaterial): Mesh {
    const left: Vector3[] = []
    const right: Vector3[] = []
    for (let z = -HALF_LEN; z <= HALF_LEN + 1e-3; z += STEP) {
      const gy = this.y(centerX, z) + lift
      left.push(new Vector3(centerX - width / 2, gy, z))
      right.push(new Vector3(centerX + width / 2, gy, z))
    }
    const r = MeshBuilder.CreateRibbon(`khal_${name}`, { pathArray: [left, right] }, this.scene)
    r.material = mat
    r.isPickable = false
    this.meshes.push(r)
    return r
  }

  /** Short dashes down a lane divider. */
  private dashes(centerX: number, mat: StandardMaterial): void {
    const dash = 3
    const gap = 6
    for (let z = -HALF_LEN; z <= HALF_LEN - dash; z += dash + gap) {
      const left: Vector3[] = []
      const right: Vector3[] = []
      for (let t = 0; t <= dash + 1e-3; t += dash) {
        const zz = z + t
        const gy = this.y(centerX, zz) + 0.04
        left.push(new Vector3(centerX - 0.09, gy, zz))
        right.push(new Vector3(centerX + 0.09, gy, zz))
      }
      const d = MeshBuilder.CreateRibbon(`khal_dash_${z}`, { pathArray: [left, right] }, this.scene)
      d.material = mat
      d.isPickable = false
      this.meshes.push(d)
    }
  }

  build(): void {
    if (this.built) return
    this.built = true

    // 1) Desert ground — tint every surface (including mud, the default) to sand.
    const t = this.sim.terrain
    t.tintGround('grass', ...C.sand)
    t.tintGround('dirt', ...C.sandDark)
    t.tintGround('rock', ...C.sand)
    t.tintGround('mud', ...C.sandDark)

    const asphaltMat = this.mat('asphalt', C.asphalt)
    const whiteMat = this.mat('white', C.white, { unlit: true })
    const yellowMat = this.mat('yellow', C.yellow, { unlit: true })
    const concreteMat = this.mat('concrete', C.concrete)
    const metalMat = this.mat('metal', C.metal, { spec: 0.4 })
    const poleMat = this.mat('pole', C.pole, { spec: 0.3 })

    // 2) The two carriageways.
    for (const side of [-1, 1] as const) {
      const cx = side * CX
      this.ribbon(`carriage_${side}`, cx, CARRIAGE_W, 0.03, asphaltMat)
      // Yellow lines on both edges of the carriageway.
      this.ribbon(`edgeIn_${side}`, cx - (CARRIAGE_W / 2) * 1, 0.18, 0.04, yellowMat)
      this.ribbon(`edgeOut_${side}`, cx + (CARRIAGE_W / 2) * 1, 0.18, 0.04, yellowMat)
      // White dashes between the three lanes (two dividers).
      this.dashes(cx - LANE_W / 2, whiteMat)
      this.dashes(cx + LANE_W / 2, whiteMat)
    }

    // 3) The raised concrete median, full length, plus lamp poles.
    this.ribbon('median', 0, MEDIAN_W, 0.16, concreteMat)
    // median kerb sides
    for (const side of [-1, 1] as const) {
      this.ribbon(`kerb_${side}`, side * (MEDIAN_W / 2), 0.06, 0.09, concreteMat)
    }
    for (let z = -HALF_LEN + 20; z <= HALF_LEN - 20; z += 45) {
      const gy = this.y(0, z)
      const pole = MeshBuilder.CreateCylinder(`khal_pole_${z}`, { diameter: 0.16, height: 6 }, this.scene)
      pole.position.set(0, gy + 3, z)
      pole.material = poleMat
      pole.isPickable = false
      this.meshes.push(pole)
    }

    // 4) Steel guardrails down both outer edges.
    for (const side of [-1, 1] as const) {
      const gx = side * (CX + CARRIAGE_W / 2 + 0.6)
      // rail
      this.ribbon(`rail_${side}`, gx, 0.12, 0.7, metalMat)
      // posts every 4 m
      for (let z = -HALF_LEN; z <= HALF_LEN; z += 4) {
        const gy = this.y(gx, z)
        const post = MeshBuilder.CreateBox(`khal_post_${side}_${z}`, { width: 0.1, height: 0.75, depth: 0.1 }, this.scene)
        post.position.set(gx, gy + 0.38, z)
        post.material = metalMat
        post.isPickable = false
        this.meshes.push(post)
      }
    }

    // 5) Sand-coloured houses set back on both sides, clustered toward the far end.
    for (let i = 0; i < 40; i++) {
      const side = i % 2 === 0 ? -1 : 1
      const dist = CX + CARRIAGE_W / 2 + 8 + Math.random() * 34
      const x = side * dist
      const z = -HALF_LEN + 30 + Math.random() * (HALF_LEN * 2 - 60)
      const w = 5 + Math.random() * 6
      const d = 5 + Math.random() * 6
      const h = 3 + Math.random() * 5
      const gy = this.y(x, z)
      const b = MeshBuilder.CreateBox(`khal_house_${i}`, { width: w, height: h, depth: d }, this.scene)
      b.position.set(x, gy + h / 2, z)
      // A little self-lit so the sand colour reads even on shadowed faces.
      b.material = this.mat(`house_${i}`, C.house[i % C.house.length], { unlit: true })
      b.isPickable = false
      this.meshes.push(b)
    }

    // 6) Park the player at the near end, looking down the road.
    this.sim.vehicle?.reset(new Vector3(CX, 0, -HALF_LEN + 12), 0)
  }

  clear(): void {
    if (!this.built) return
    this.built = false
    for (const m of this.meshes) m.dispose()
    this.meshes.length = 0
    for (const m of this.mats) m.dispose()
    this.mats.length = 0
  }
}
