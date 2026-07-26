import {
  Color3,
  Matrix,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type LinesMesh,
  type Mesh,
  type Scene,
} from '@babylonjs/core'

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
 * Everything hugs the terrain: each frame a car's height comes from the field,
 * its heading from the path tangent, and its tilt from the ground normal, so it
 * leans into slopes instead of clipping through them. The wheels roll by the
 * real distance covered, so they never look frozen.
 *
 * The cars are generated meshes — a body, a cabin, four rolling wheels — not
 * downloaded assets, so a fleet of sixty costs nothing to load. Materials are a
 * shared palette; only the geometry is cloned per car.
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

interface Car {
  holder: TransformNode
  wheels: TransformNode[]
  meshes: AbstractMesh[]
  lane: Lane
  /** Arc-length position along the lane. */
  s: number
  /** Per-car speed multiplier, so a fleet does not move in lockstep. */
  speedMul: number
  wheelRadius: number
  /** Accumulated wheel spin, radians. */
  spin: number
}

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

  private count = 8
  private speed = 9 // metres per second
  private playing = false

  private bodyMats: StandardMaterial[] = []
  private wheelMat!: StandardMaterial
  private glassMat!: StandardMaterial
  private readonly obs: () => void
  private seq = 0

  // Scratch, reused every frame to avoid per-car allocation.
  private readonly _n = { x: 0, y: 1, z: 0 }
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
      const moved = this.speed * car.speedMul * dt
      car.s = (car.s + moved) % lane.total
      if (car.s < 0) car.s += lane.total

      this.placeCar(car, field)

      // Roll the wheels by the real distance covered.
      car.spin += moved / car.wheelRadius
      for (const w of car.wheels) w.rotation.x = car.spin
    }
  }

  /** Seat a car on its lane at its current arc-length — position and heading. */
  private placeCar(car: Car, field: NonNullable<ReturnType<TrafficSystem['getField']>>): void {
    this.sampleLane(car.lane, car.s)
    const gx = this._pos.x
    const gz = this._pos.z
    const gy = field.surfaceHeight(gx, gz)

    // Heading from the path tangent, tilt from the ground normal.
    field.normalAt(gx, gz, this._n)
    const up = new Vector3(this._n.x, this._n.y, this._n.z)
    if (up.lengthSquared() < 1e-6) up.set(0, 1, 0)
    up.normalize()
    let fwd = new Vector3(this._tan.x, 0, this._tan.z)
    if (fwd.lengthSquared() < 1e-9) fwd.set(0, 0, 1)
    fwd.normalize()
    // Re-orthogonalise forward against the slope's up so the car sits flat.
    const right = Vector3.Cross(up, fwd)
    right.normalize()
    fwd = Vector3.Cross(right, up)
    fwd.normalize()

    // Build the rotation directly from the basis: the car's body runs along its
    // local +Z, so mapping local X→right, Y→up, Z→forward points it down the
    // path. (Row i of a Babylon matrix is the image of local axis i.)
    if (!car.holder.rotationQuaternion) car.holder.rotationQuaternion = new Quaternion()
    Matrix.FromValuesToRef(
      right.x, right.y, right.z, 0,
      up.x, up.y, up.z, 0,
      fwd.x, fwd.y, fwd.z, 0,
      0, 0, 0, 1,
      this._basis,
    )
    Quaternion.FromRotationMatrixToRef(this._basis, car.holder.rotationQuaternion)
    car.holder.position.set(gx, gy, gz)
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
    if (usable.length === 0 || this.count === 0) {
      if (this.cars.length === 0) this.playing = this.playing && usable.length > 0
      return
    }

    // Spread the fleet round-robin across lanes, then evenly along each lane.
    const perLane: Car[][] = usable.map(() => [])
    for (let i = 0; i < this.count; i++) {
      const lane = usable[i % usable.length]
      const car = this.buildCar(lane, i)
      this.cars.push(car)
      perLane[i % usable.length].push(car)
    }
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

  private buildCar(lane: Lane, index: number): Car {
    const id = this.seq++
    const holder = new TransformNode(`traffic_car_${id}`, this.scene)
    holder.rotationQuaternion = new Quaternion()

    const wheelRadius = 0.38
    const meshes: AbstractMesh[] = []
    const wheels: TransformNode[] = []

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
      wheels.push(pivot)
    }

    return {
      holder,
      wheels,
      meshes,
      lane,
      s: 0,
      speedMul: 0.82 + Math.random() * 0.4,
      wheelRadius,
      spin: 0,
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
    for (const w of car.wheels) w.dispose()
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
    for (const m of this.bodyMats) m.dispose()
    this.wheelMat?.dispose()
    this.glassMat?.dispose()
  }
}
