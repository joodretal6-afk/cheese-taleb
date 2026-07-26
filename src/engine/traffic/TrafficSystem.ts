import {
  Color3,
  ImportMeshAsync,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type LinesMesh,
  type Scene,
} from '@babylonjs/core'
import '@babylonjs/loaders/glTF'
import { DEFAULT_WHEEL_HINTS } from '../VehicleModel'

/**
 * Traffic.
 *
 * You draw a path on the ground — a chain of waypoints — and cars drive along
 * it on their own. Draw several and the fleet spreads across all of them. A
 * count decides how many cars, a speed decides how fast, and play/pause starts
 * and stops the whole flow.
 *
 * A drawn path is treated as a closed loop: a car reaching the last waypoint
 * carries on to the first, so it circulates forever with no teleport. Draw a
 * ring road and it never has a visible seam; draw a straight line and the car
 * runs it there-and-back.
 *
 * Everything sits on its wheels: each frame the ground is sampled under the
 * four corners of the wheelbase, and the car's height and tilt come from that
 * footprint — so it rests on a real four-point contact, follows slopes, and
 * never sinks a corner into a dip. The wheels roll by the real distance
 * covered, and the front pair steers toward the path ahead, so a turning car
 * turns its wheels.
 *
 * The generated cars are meshes — a body, a cabin, four rolling wheels. An
 * uploaded library model is cloned per car and its wheels are found by name and
 * wrapped so they roll and steer too. Materials are a shared palette; only the
 * geometry is cloned per car, so a fleet of sixty costs nothing to load.
 *
 * The whole thing is self-contained: it reaches the world only through the
 * scene it draws into and a getter for the current mud field, so a world
 * rebuild (a new region, a quality change) never leaves it holding a stale
 * surface — the next frame simply re-drapes onto whatever field is current.
 */

interface Lane {
  /** Waypoints in world space; y is only a hint, height is resampled per frame. */
  points: Vector3[]
  /** Cumulative arc length at the start of each segment (closing segment included). */
  cum: number[]
  /** Length of each segment, index-aligned with `cum`. */
  seg: number[]
  /** Total loop length. */
  total: number
  /** The drawn polyline, drawn draped over the ground. */
  line: LinesMesh | null
  /** Small markers at each waypoint. */
  markers: Mesh[]
}

/**
 * A wheel we drive ourselves: a node at the wheel's centre that we roll (about
 * the axle) and, for the front pair, steer (about vertical).
 */
interface ManagedWheel {
  node: TransformNode
  /** World radius, so roll = distance / radius. */
  radius: number
  /** Front wheels steer; rear wheels only roll. */
  front: boolean
}

interface Car {
  holder: TransformNode
  wheels: ManagedWheel[]
  meshes: AbstractMesh[]
  lane: Lane
  /** Arc-length position along the lane. */
  s: number
  /** Per-car speed multiplier, so a fleet does not move in lockstep. */
  speedMul: number
  /** Distance travelled, drives wheel roll. */
  dist: number
  /** Smoothed steering angle of the front wheels, radians. */
  steer: number
  /** Half the car's length and width in world units, for the ground fit. */
  halfLen: number
  halfWid: number
  /** A model whose front points the wrong way is turned 180° here. */
  flip: boolean
  /** Present on library-model cars: what's needed to hijack and drive it. */
  source?: { url: string; name: string; ext: string }
}

/** One entry in the car library: an uploaded model and how many to spawn. */
interface CarType {
  id: string
  name: string
  count: number
  /** The loaded, base-seated template cloned per car. */
  template: TransformNode
  /** Longest horizontal side of the template, for scaling to a car length. */
  longest: number
  /** Template-space full size along x/z, for the ground-fit footprint. */
  sizeX: number
  sizeZ: number
  /** How many wheel meshes were found by name (0 = none roll). */
  wheelsDetected: number
  /** Front points the wrong way? Turn every car of this type around. */
  flip: boolean
  /** The GLB URL/ext this was loaded from, so a hijack can drive it. */
  url: string
  ext: string
}

/** Uploaded car models are normalised to about this length (metres). */
const TARGET_CAR_LENGTH = 4.5
/** At most this many library slots. */
const MAX_CAR_TYPES = 50
/** A car brakes for the player once they're this close ahead (metres). */
const BRAKE_DISTANCE = 7
/** Peak steering angle of the front wheels, radians (~31°). */
const MAX_STEER = 0.55

const BODY_COLORS: [number, number, number][] = [
  [0.82, 0.24, 0.22], // red
  [0.16, 0.34, 0.7], // blue
  [0.9, 0.78, 0.2], // yellow
  [0.85, 0.85, 0.88], // white
  [0.15, 0.16, 0.2], // near-black
  [0.2, 0.5, 0.32], // green
  [0.9, 0.5, 0.15], // orange
  [0.4, 0.42, 0.48], // grey
]

export class TrafficSystem {
  private readonly scene: Scene
  private readonly getField: () => { surfaceHeight(x: number, z: number): number; normalAt(x: number, z: number, out: { x: number; y: number; z: number }, eps?: number): void; worldSize: number } | undefined

  private readonly lanes: Lane[] = []
  private active: Lane | null = null
  private readonly cars: Car[] = []

  /** The car library: uploaded models keyed by id. */
  private readonly models = new Map<string, CarType>()

  private count = 8 // generated (box) cars
  private speed = 9 // metres per second
  private playing = false

  /** The on-foot player's ground position; cars stop for it when it's ahead. */
  private blocker: { x: number; z: number } | null = null

  private bodyMats: StandardMaterial[] = []
  private wheelMat!: StandardMaterial
  private glassMat!: StandardMaterial
  private readonly obs: () => void
  private seq = 0

  // Scratch, reused every frame to avoid per-car allocation.
  private readonly _pos = new Vector3()
  private readonly _tan = new Vector3()
  private readonly _basis = Matrix.Identity()

  constructor(scene: Scene, getField: TrafficSystem['getField']) {
    this.scene = scene
    this.getField = getField
    this.buildMaterials()
    this.obs = () => this.update()
    this.scene.onBeforeRenderObservable.add(this.obs)
  }

  // ------------------------------------------------------------- lane drawing

  /** Start a fresh path. Any half-drawn one is discarded. */
  beginLane(): void {
    this.cancelLane()
    this.active = { points: [], cum: [], seg: [], total: 0, line: null, markers: [] }
  }

  get drawing(): boolean {
    return this.active !== null
  }

  get activePointCount(): number {
    return this.active?.points.length ?? 0
  }

  /** Add a waypoint at a world position. */
  addWaypoint(x: number, z: number): void {
    if (!this.active) this.beginLane()
    const y = this.field?.surfaceHeight(x, z) ?? 0
    this.active!.points.push(new Vector3(x, y, z))
    this.redrawActive()
  }

  /** Finalise the current path. Needs at least two points. Returns success. */
  endLane(): boolean {
    const lane = this.active
    if (!lane || lane.points.length < 2) return false
    this.computeLaneArc(lane)
    this.styleLine(lane, false)
    this.lanes.push(lane)
    this.active = null
    this.rebuildCars()
    return true
  }

  /** Throw away the path being drawn without keeping it. */
  cancelLane(): void {
    if (!this.active) return
    this.disposeLane(this.active)
    this.active = null
  }

  /** Remove every path and every car. */
  clearLanes(): void {
    this.cancelLane()
    for (const l of this.lanes) this.disposeLane(l)
    this.lanes.length = 0
    this.rebuildCars()
  }

  laneCount(): number {
    return this.lanes.length
  }

  // -------------------------------------------------------------------- fleet

  setCount(n: number): void {
    this.count = Math.max(0, Math.min(200, Math.round(n)))
    this.rebuildCars()
  }

  getCount(): number {
    return this.count
  }

  carCount(): number {
    return this.cars.length
  }

  setSpeed(mps: number): void {
    this.speed = Math.max(0, mps)
  }

  getSpeed(): number {
    return this.speed
  }

  // ------------------------------------------------------------- car library

  /**
   * Add an uploaded GLB as a car type. Loads it once into a template that is
   * cloned per car, normalised so its longest side is about a car length and
   * re-seated so its wheels sit on the ground. Returns the type id, or null on
   * a failed load or when the library is full.
   */
  async addModel(url: string, name: string, ext?: string): Promise<string | null> {
    if (this.models.size >= MAX_CAR_TYPES) return null
    const loaded = await this.loadTemplate(url, ext)
    if (!loaded) return null
    const id = `carType_${this.seq++}`
    this.models.set(id, {
      id,
      name: name || `طراز ${this.models.size + 1}`,
      count: 3,
      template: loaded.node,
      longest: loaded.longest,
      sizeX: loaded.sizeX,
      sizeZ: loaded.sizeZ,
      wheelsDetected: loaded.wheels,
      flip: false,
      url,
      ext: ext ?? '.glb',
    })
    this.rebuildCars()
    return id
  }

  setModelCount(id: string, n: number): void {
    const t = this.models.get(id)
    if (!t) return
    t.count = Math.max(0, Math.min(50, Math.round(n)))
    this.rebuildCars()
  }

  setModelFlip(id: string, flip: boolean): void {
    const t = this.models.get(id)
    if (!t) return
    t.flip = flip
    this.rebuildCars()
  }

  removeModel(id: string): void {
    const t = this.models.get(id)
    if (!t) return
    t.template.dispose()
    this.models.delete(id)
    this.rebuildCars()
  }

  listModels(): { id: string; name: string; count: number; flip: boolean; wheels: number }[] {
    return [...this.models.values()].map((t) => ({
      id: t.id,
      name: t.name,
      count: t.count,
      flip: t.flip,
      wheels: t.wheelsDetected,
    }))
  }

  play(): void {
    this.playing = this.lanes.length > 0
  }

  pause(): void {
    this.playing = false
  }

  get running(): boolean {
    return this.playing
  }

  // ------------------------------------------------------------- ground pick

  /**
   * The ground point under a screen position, by marching the camera ray
   * against the field. Independent of whether the terrain mesh is pickable, so
   * it works while any other tool has claimed picking.
   */
  pickGround(screenX: number, screenY: number): Vector3 | null {
    const field = this.field
    const cam = this.scene.activeCamera
    if (!field || !cam) return null
    const ray = this.scene.createPickingRay(screenX, screenY, null, cam)
    const o = ray.origin
    const d = ray.direction
    if (d.y >= -1e-4 && o.y - field.surfaceHeight(o.x, o.z) > 0) {
      // Ray points up or level from above ground — still march, it may dip.
    }
    const maxT = (field.worldSize ?? 400) * 1.6 + 200
    const step = 1.25
    let prev = o.y - field.surfaceHeight(o.x, o.z)
    for (let s = step; s <= maxT; s += step) {
      const x = o.x + d.x * s
      const z = o.z + d.z * s
      const cur = o.y + d.y * s - field.surfaceHeight(x, z)
      if (prev > 0 && cur <= 0) {
        // Bisect the crossing for a clean hit.
        let lo = s - step
        let hi = s
        for (let k = 0; k < 14; k++) {
          const m = (lo + hi) * 0.5
          const hx = o.x + d.x * m
          const hz = o.z + d.z * m
          const dv = o.y + d.y * m - field.surfaceHeight(hx, hz)
          if (dv > 0) lo = m
          else hi = m
        }
        const m = (lo + hi) * 0.5
        const hx = o.x + d.x * m
        const hz = o.z + d.z * m
        return new Vector3(hx, field.surfaceHeight(hx, hz), hz)
      }
      prev = cur
    }
    return null
  }

  // --------------------------------------------------------------- per-frame

  private update(): void {
    if (!this.playing || this.cars.length === 0) return
    const field = this.field
    if (!field) return
    const dt = Math.min(0.05, this.scene.getEngine().getDeltaTime() / 1000)

    for (const car of this.cars) {
      const lane = car.lane
      if (lane.total <= 0) continue
      let moved = this.speed * car.speedMul * dt
      // Yield to the player: if they're standing in the road ahead of this car,
      // it brakes to a stop rather than driving through them — GTA-style.
      if (this.blocker && this.isBlockedAhead(car)) moved = 0
      car.s = (car.s + moved) % lane.total
      if (car.s < 0) car.s += lane.total
      car.dist += moved

      this.placeCar(car, field)

      // Steering: compare the current travel heading with the path direction a
      // few metres ahead. A drawn path is piecewise-straight, so a per-frame
      // heading delta would only twitch at the corners; looking ahead gives a
      // steady, natural steer through the whole curve.
      this.sampleLane(car.lane, car.s)
      const cx = this._pos.x
      const cz = this._pos.z
      const curHeading = Math.atan2(this._tan.x, this._tan.z)
      const look = Math.min(lane.total * 0.24, Math.max(3, car.halfLen * 2.5))
      this.sampleLane(car.lane, (car.s + look) % lane.total)
      const desired = Math.atan2(this._pos.x - cx, this._pos.z - cz)
      let d = desired - curHeading
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      const steerTarget = Math.max(-MAX_STEER, Math.min(MAX_STEER, d * 0.9))
      car.steer += (steerTarget - car.steer) * Math.min(1, dt * 6)

      // Roll every wheel by the real distance; steer the front pair.
      for (const w of car.wheels) {
        const roll = car.dist / w.radius
        const steer = w.front ? car.steer : 0
        if (!w.node.rotationQuaternion) w.node.rotationQuaternion = new Quaternion()
        Quaternion.RotationYawPitchRollToRef(steer, roll, 0, w.node.rotationQuaternion)
      }
    }
  }

  /** Is the blocker close and within this car's forward cone? */
  private isBlockedAhead(car: Car): boolean {
    if (!this.blocker) return false
    // Sample the car's current position and tangent without advancing it.
    this.sampleLane(car.lane, car.s)
    let fx = this._tan.x
    let fz = this._tan.z
    const fl = Math.hypot(fx, fz) || 1
    fx /= fl
    fz /= fl
    if (car.flip) {
      fx = -fx
      fz = -fz
    }
    const dx = this.blocker.x - this._pos.x
    const dz = this.blocker.z - this._pos.z
    const dist = Math.hypot(dx, dz)
    if (dist > BRAKE_DISTANCE || dist < 1e-3) return dist <= BRAKE_DISTANCE
    // Ahead means the player is within a forward cone, not behind or beside.
    const fdot = (dx * fx + dz * fz) / dist
    return fdot > 0.45
  }

  /** Set (or clear, with null) the on-foot player's ground position. */
  setBlocker(x: number | null, z = 0): void {
    this.blocker = x === null ? null : { x, z }
  }

  /**
   * The nearest hijackable (library-model) car within `maxDist` of a point, or
   * null. Returns what a caller needs to swap the player vehicle to that model,
   * plus a despawn() to remove the NPC car once it's been stolen.
   */
  nearestHijackable(
    x: number,
    z: number,
    maxDist: number,
  ): { url: string; name: string; ext: string; x: number; z: number; yaw: number; despawn: () => void } | null {
    let best: Car | null = null
    let bestD = maxDist
    for (const car of this.cars) {
      if (!car.source) continue
      const p = car.holder.position
      const d = Math.hypot(p.x - x, p.z - z)
      if (d < bestD) {
        bestD = d
        best = car
      }
    }
    if (!best || !best.source) return null
    const p = best.holder.position
    const q = best.holder.rotationQuaternion
    let yaw = 0
    if (q) yaw = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y))
    const target = best
    return {
      url: best.source.url,
      name: best.source.name,
      ext: best.source.ext,
      x: p.x,
      z: p.z,
      yaw,
      despawn: () => this.despawnCar(target),
    }
  }

  private despawnCar(car: Car): void {
    const i = this.cars.indexOf(car)
    if (i >= 0) this.cars.splice(i, 1)
    this.disposeCar(car)
  }

  /**
   * Seat a car on its lane at its current arc-length. The height and tilt come
   * from sampling the terrain under the four wheels (a footprint fit), not a
   * single centre point — so the car rests on its wheels, follows slopes like a
   * real car, and never sinks a corner into a dip.
   */
  private placeCar(car: Car, field: NonNullable<ReturnType<TrafficSystem['getField']>>): void {
    this.sampleLane(car.lane, car.s)
    const cx = this._pos.x
    const cz = this._pos.z

    // Travel forward on the plane, and the right vector beside it.
    let fx = this._tan.x
    let fz = this._tan.z
    const fl = Math.hypot(fx, fz) || 1
    fx /= fl
    fz /= fl
    if (car.flip) {
      fx = -fx
      fz = -fz
    }
    const rx = fz
    const rz = -fx

    // Sample the ground under the four corners of the wheelbase.
    const L = car.halfLen
    const W = car.halfWid
    const cornerH = (a: number, b: number) =>
      field.surfaceHeight(cx + fx * a * L + rx * b * W, cz + fz * a * L + rz * b * W)
    const hFR = cornerH(1, 1)
    const hFL = cornerH(1, -1)
    const hRR = cornerH(-1, 1)
    const hRL = cornerH(-1, -1)
    const centreH = (hFR + hFL + hRR + hRL) * 0.25

    // Forward and right tilt from the height differences across the footprint.
    const forward = new Vector3(2 * L * fx, (hFR + hFL) * 0.5 - (hRR + hRL) * 0.5, 2 * L * fz)
    forward.normalize()
    const rightV = new Vector3(2 * W * rx, (hFR + hRR) * 0.5 - (hFL + hRL) * 0.5, 2 * W * rz)
    rightV.normalize()
    const up = Vector3.Cross(forward, rightV)
    if (up.y < 0) up.negateInPlace()
    up.normalize()
    // Re-orthonormalise so the basis is clean.
    const right = Vector3.Cross(up, forward)
    right.normalize()
    const fwd = Vector3.Cross(right, up)
    fwd.normalize()

    if (!car.holder.rotationQuaternion) car.holder.rotationQuaternion = new Quaternion()
    Matrix.FromValuesToRef(
      right.x, right.y, right.z, 0,
      up.x, up.y, up.z, 0,
      fwd.x, fwd.y, fwd.z, 0,
      0, 0, 0, 1,
      this._basis,
    )
    Quaternion.FromRotationMatrixToRef(this._basis, car.holder.rotationQuaternion)
    car.holder.position.set(cx, centreH, cz)
  }

  // ---------------------------------------------------------------- geometry

  /** Position (`_pos`) and tangent (`_tan`) at arc-length `s` along a lane. */
  private sampleLane(lane: Lane, s: number): void {
    const n = lane.points.length
    // Binary-ish linear scan — lanes are short, a plain scan is plenty.
    let k = 0
    while (k < lane.seg.length - 1 && s >= lane.cum[k] + lane.seg[k]) k++
    const a = lane.points[k]
    const b = lane.points[(k + 1) % n]
    const len = lane.seg[k] || 1e-6
    const f = Math.min(1, Math.max(0, (s - lane.cum[k]) / len))
    this._pos.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f)
    this._tan.set(b.x - a.x, 0, b.z - a.z)
  }

  private computeLaneArc(lane: Lane): void {
    const pts = lane.points
    const n = pts.length
    lane.cum = []
    lane.seg = []
    let total = 0
    for (let i = 0; i < n; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % n] // closing segment wraps to the first point
      const len = Math.hypot(b.x - a.x, b.z - a.z)
      lane.cum.push(total)
      lane.seg.push(len)
      total += len
    }
    lane.total = total
  }

  // --------------------------------------------------------------- car build

  private rebuildCars(): void {
    for (const c of this.cars) this.disposeCar(c)
    this.cars.length = 0

    const usable = this.lanes.filter((l) => l.total > 1e-3)
    if (usable.length === 0) {
      this.playing = false
      return
    }

    // One factory per car to spawn: the generated box cars first, then every
    // library model repeated by its own count. Flattening to a single list lets
    // the whole mixed fleet spread evenly across the lanes together.
    const factories: ((lane: Lane, idx: number) => Car)[] = []
    for (let i = 0; i < this.count; i++) factories.push((lane, idx) => this.buildCar(lane, idx))
    for (const t of this.models.values()) {
      for (let i = 0; i < t.count; i++) factories.push((lane) => this.buildModelCar(lane, t))
    }
    if (factories.length === 0) return

    const perLane: Car[][] = usable.map(() => [])
    factories.forEach((make, i) => {
      const lane = usable[i % usable.length]
      const car = make(lane, i)
      this.cars.push(car)
      perLane[i % usable.length].push(car)
    })

    const field = this.field
    for (let li = 0; li < usable.length; li++) {
      const group = perLane[li]
      const m = group.length
      for (let j = 0; j < m; j++) {
        group[j].s = (usable[li].total * j) / m
        // Seat each car on the road immediately, so a fresh or paused fleet is
        // already lined up along the path rather than piled at the origin.
        if (field) this.placeCar(group[j], field)
      }
    }
  }

  /** A car cloned from an uploaded library model, with its wheels made to spin. */
  private buildModelCar(lane: Lane, type: CarType): Car {
    const id = this.seq++
    const holder = new TransformNode(`traffic_car_${id}`, this.scene)
    holder.rotationQuaternion = new Quaternion()

    const meshes: AbstractMesh[] = []
    const clone = type.template.clone(`traffic_modelgeo_${id}`, holder)
    const scale = TARGET_CAR_LENGTH / type.longest

    const wheels: ManagedWheel[] = []
    let wbLen = (type.sizeZ / 2) * 0.7
    let wbWid = (type.sizeX / 2) * 0.85
    if (clone) {
      clone.setEnabled(true)
      for (const m of clone.getChildMeshes()) {
        m.isPickable = false
        meshes.push(m)
      }
      if (clone instanceof Mesh) meshes.push(clone)

      // Find the wheel meshes by name and wrap each in a node at its centre, so
      // we can roll it about its axle and steer the front pair.
      holder.computeWorldMatrix(true)
      const found = this.detectWheels(holder)
      for (const w of found) {
        const container = new TransformNode(`traffic_wheel_${id}_${wheels.length}`, this.scene)
        container.parent = holder
        container.position.copyFrom(w.centerLocal)
        container.rotationQuaternion = new Quaternion()
        w.mesh.setParent(container)
        w.mesh.isPickable = false
        const front = type.flip ? w.centerLocal.z < 0 : w.centerLocal.z > 0
        wheels.push({ node: container, radius: Math.max(0.05, w.radiusLocal * scale), front })
      }
      // Fit the ground footprint to the real wheels when we found them.
      if (found.length) {
        wbLen = Math.max(...found.map((w) => Math.abs(w.centerLocal.z))) || wbLen
        wbWid = Math.max(...found.map((w) => Math.abs(w.centerLocal.x))) || wbWid
      }
    }
    // Normalise to a car length; the template already sits with its base on y=0.
    holder.scaling.setAll(scale)

    return {
      holder,
      wheels,
      meshes,
      lane,
      s: 0,
      speedMul: 0.82 + Math.random() * 0.4,
      dist: 0,
      steer: 0,
      halfLen: Math.max(0.6, wbLen * scale),
      halfWid: Math.max(0.4, wbWid * scale),
      flip: type.flip,
      source: { url: type.url, name: type.name, ext: type.ext },
    }
  }

  /**
   * Find the wheel meshes of a just-cloned model (holder at identity, scale 1),
   * returning each with its centre in holder-local space and its radius. Wheels
   * are matched by the same name hints the vehicle loader uses.
   */
  private detectWheels(
    holder: TransformNode,
  ): { mesh: AbstractMesh; centerLocal: Vector3; radiusLocal: number }[] {
    const hints = DEFAULT_WHEEL_HINTS.map((h) => h.toLowerCase())
    const out: { mesh: AbstractMesh; centerLocal: Vector3; radiusLocal: number }[] = []
    for (const m of holder.getChildMeshes()) {
      const name = m.name.toLowerCase()
      if (!hints.some((h) => name.includes(h))) continue
      if (!m.getTotalVertices?.()) continue
      m.computeWorldMatrix(true)
      const bb = m.getBoundingInfo().boundingBox
      const min = bb.minimumWorld
      const max = bb.maximumWorld
      const center = new Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2)
      // The wheel's radius is half of its two larger extents (the circular face).
      const ext = [max.x - min.x, max.y - min.y, max.z - min.z].sort((a, b) => b - a)
      const radius = (ext[0] + ext[1]) * 0.25
      out.push({ mesh: m, centerLocal: center, radiusLocal: radius })
    }
    return out
  }

  private buildCar(lane: Lane, index: number): Car {
    const id = this.seq++
    const holder = new TransformNode(`traffic_car_${id}`, this.scene)
    holder.rotationQuaternion = new Quaternion()

    const wheelRadius = 0.38
    const meshes: AbstractMesh[] = []
    const wheels: ManagedWheel[] = []

    const bodyMat = this.bodyMats[index % this.bodyMats.length]

    // Body sits above the wheels; the whole car's origin is the ground contact
    // point directly beneath its centre, so placing the holder at surface height
    // stands the tyres on the ground.
    const body = MeshBuilder.CreateBox(
      `traffic_body_${id}`,
      { width: 1.72, height: 0.72, depth: 4.0 },
      this.scene,
    )
    body.material = bodyMat
    body.parent = holder
    body.position.y = wheelRadius + 0.42
    body.isPickable = false
    meshes.push(body)

    const cabin = MeshBuilder.CreateBox(
      `traffic_cabin_${id}`,
      { width: 1.5, height: 0.62, depth: 2.0 },
      this.scene,
    )
    cabin.material = this.glassMat
    cabin.parent = holder
    cabin.position.set(0, wheelRadius + 0.42 + 0.65, -0.2)
    cabin.isPickable = false
    meshes.push(cabin)

    // Four wheels, each under a pivot so rolling is just a rotation about x.
    const wx = 0.86
    const wz = 1.32
    for (const [sx, sz] of [
      [wx, wz],
      [-wx, wz],
      [wx, -wz],
      [-wx, -wz],
    ] as const) {
      const pivot = new TransformNode(`traffic_wheelpivot_${id}_${sx}_${sz}`, this.scene)
      pivot.parent = holder
      pivot.position.set(sx, wheelRadius, sz)
      pivot.rotationQuaternion = new Quaternion()
      const wheel = MeshBuilder.CreateCylinder(
        `traffic_wheel_${id}_${sx}_${sz}`,
        { diameter: wheelRadius * 2, height: 0.26, tessellation: 14 },
        this.scene,
      )
      // Lay the cylinder on its side so its axle points along the car's width.
      wheel.rotation.z = Math.PI / 2
      wheel.material = this.wheelMat
      wheel.parent = pivot
      wheel.isPickable = false
      meshes.push(wheel)
      wheels.push({ node: pivot, radius: wheelRadius, front: sz > 0 })
    }

    return {
      holder,
      wheels,
      meshes,
      lane,
      s: 0,
      speedMul: 0.82 + Math.random() * 0.4,
      dist: 0,
      steer: 0,
      halfLen: 1.6,
      halfWid: 0.9,
      flip: false,
    }
  }

  /**
   * Load a GLB into a template node: drop the loader's handedness root, measure
   * the footprint, and re-seat so the model is centred on x/z with its base on
   * y = 0 — so a clone placed at a ground point stands on it. Mirrors the
   * brush's model loader.
   */
  private async loadTemplate(
    url: string,
    ext?: string,
  ): Promise<{ node: TransformNode; longest: number; sizeX: number; sizeZ: number; wheels: number } | null> {
    try {
      const result = await ImportMeshAsync(url, this.scene, { pluginExtension: ext })
      const meshes = result.meshes.filter(
        (m): m is Mesh => m instanceof Mesh && !!m.getTotalVertices(),
      )
      if (meshes.length === 0) {
        for (const m of result.meshes) m.dispose()
        return null
      }
      const template = new TransformNode(`carTemplate_${this.seq++}`, this.scene)
      for (const m of meshes) m.setParent(template)
      for (const m of result.meshes) if (m.name === '__root__') m.dispose()
      template.computeWorldMatrix(true)

      const min = new Vector3(Infinity, Infinity, Infinity)
      const max = new Vector3(-Infinity, -Infinity, -Infinity)
      for (const m of meshes) {
        m.computeWorldMatrix(true)
        const bb = m.getBoundingInfo().boundingBox
        min.minimizeInPlace(bb.minimumWorld)
        max.maximizeInPlace(bb.maximumWorld)
      }
      for (const m of meshes) {
        m.position.subtractInPlace(new Vector3((min.x + max.x) / 2, min.y, (min.z + max.z) / 2))
      }
      const sizeX = max.x - min.x
      const sizeZ = max.z - min.z
      const longest = Math.max(0.01, Math.max(sizeX, sizeZ))
      const wheels = this.detectWheels(template).length
      template.setEnabled(false)
      return { node: template, longest, sizeX, sizeZ, wheels }
    } catch (err) {
      console.error('[traffic] could not load car model', url, err)
      return null
    }
  }

  private buildMaterials(): void {
    this.bodyMats = BODY_COLORS.map(([r, g, b], i) => {
      const m = new StandardMaterial(`traffic_bodymat_${i}`, this.scene)
      m.diffuseColor = new Color3(r, g, b)
      m.specularColor = new Color3(0.3, 0.3, 0.3)
      return m
    })
    this.wheelMat = new StandardMaterial('traffic_wheelmat', this.scene)
    this.wheelMat.diffuseColor = new Color3(0.06, 0.06, 0.07)
    this.wheelMat.specularColor = new Color3(0.1, 0.1, 0.1)
    this.glassMat = new StandardMaterial('traffic_glassmat', this.scene)
    this.glassMat.diffuseColor = new Color3(0.2, 0.26, 0.32)
    this.glassMat.specularColor = new Color3(0.5, 0.5, 0.55)
    this.glassMat.alpha = 0.85
  }

  // ----------------------------------------------------------------- drawing

  private redrawActive(): void {
    if (!this.active) return
    this.styleLine(this.active, true)
    this.drawMarkers(this.active, true)
  }

  private styleLine(lane: Lane, isActive: boolean): void {
    if (lane.line) {
      lane.line.dispose()
      lane.line = null
    }
    if (lane.points.length < 2) return
    const field = this.field
    const lift = 0.18
    const loop = isActive ? lane.points : [...lane.points, lane.points[0]]
    const pts = loop.map(
      (p) => new Vector3(p.x, (field?.surfaceHeight(p.x, p.z) ?? p.y) + lift, p.z),
    )
    const line = MeshBuilder.CreateLines(`traffic_lane_${this.seq++}`, { points: pts }, this.scene)
    line.color = isActive ? new Color3(0.95, 0.7, 0.15) : new Color3(0.2, 0.7, 1)
    line.isPickable = false
    lane.line = line
  }

  private drawMarkers(lane: Lane, isActive: boolean): void {
    for (const m of lane.markers) m.dispose()
    lane.markers = []
    if (!isActive) return
    const field = this.field
    for (const p of lane.points) {
      const dot = MeshBuilder.CreateSphere(`traffic_dot_${this.seq++}`, { diameter: 0.6 }, this.scene)
      dot.position.set(p.x, (field?.surfaceHeight(p.x, p.z) ?? p.y) + 0.3, p.z)
      const mat = new StandardMaterial(`traffic_dotmat_${this.seq++}`, this.scene)
      mat.emissiveColor = new Color3(0.95, 0.7, 0.15)
      mat.disableLighting = true
      dot.material = mat
      dot.isPickable = false
      lane.markers.push(dot)
    }
  }

  // --------------------------------------------------------------- teardown

  private disposeLane(lane: Lane): void {
    lane.line?.dispose()
    lane.line = null
    for (const m of lane.markers) {
      m.material?.dispose()
      m.dispose()
    }
    lane.markers = []
  }

  private disposeCar(car: Car): void {
    for (const m of car.meshes) m.dispose()
    for (const w of car.wheels) w.node.dispose()
    car.holder.dispose()
  }

  private get field() {
    return this.getField()
  }

  dispose(): void {
    this.scene.onBeforeRenderObservable.removeCallback(this.obs)
    for (const c of this.cars) this.disposeCar(c)
    this.cars.length = 0
    this.cancelLane()
    for (const l of this.lanes) this.disposeLane(l)
    this.lanes.length = 0
    for (const t of this.models.values()) t.template.dispose()
    this.models.clear()
    for (const m of this.bodyMats) m.dispose()
    this.wheelMat?.dispose()
    this.glassMat?.dispose()
  }
}
