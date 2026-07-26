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

/**
 * Pedestrians.
 *
 * The same idea as traffic, for people: draw a footpath on the ground and NPCs
 * walk it on their own, looping, hugging the terrain, facing the way they go. A
 * count sets how many, a speed sets how fast.
 *
 * Two kinds of walker:
 *   - generated: a little articulated figure (torso, head, two legs, two arms)
 *     whose limbs swing by the real distance covered, so it reads as walking
 *     without any imported animation.
 *   - model: an uploaded GLB character, cloned per walker, normalised to human
 *     height and given a gentle walking bob and sway. (Independent skeletal
 *     animation per clone is deliberately avoided — it is fragile across
 *     arbitrary rigs — so movement is procedural and always works.)
 *
 * Self-contained: it reaches the world only through the scene and a getter for
 * the current mud field, exactly like the traffic system, so a world rebuild
 * never leaves it holding a stale surface.
 */

interface Path {
  points: Vector3[]
  cum: number[]
  seg: number[]
  total: number
  line: LinesMesh | null
  markers: Mesh[]
}

interface Walker {
  holder: TransformNode
  /** Hip pivots (generated figures only) for the leg swing. */
  legs: TransformNode[]
  /** Shoulder pivots (generated figures only) for the arm swing. */
  arms: TransformNode[]
  meshes: AbstractMesh[]
  path: Path
  s: number
  speedMul: number
  /** Distance walked, drives the gait phase. */
  dist: number
  isModel: boolean
  flip: boolean
}

interface PersonType {
  id: string
  name: string
  count: number
  template: TransformNode
  /** Tallest dimension of the template, to normalise to human height. */
  tallest: number
  flip: boolean
}

/** Uploaded character models are normalised to about this height (metres). */
const HUMAN_HEIGHT = 1.75
const MAX_PERSON_TYPES = 50
/** Radians of limb swing per metre walked. */
const GAIT_RATE = 5.2
/** Clothing colours for the generated figures. */
const SHIRT_COLORS: [number, number, number][] = [
  [0.2, 0.35, 0.7],
  [0.75, 0.25, 0.25],
  [0.2, 0.55, 0.35],
  [0.85, 0.8, 0.3],
  [0.5, 0.3, 0.6],
  [0.85, 0.85, 0.88],
  [0.3, 0.32, 0.38],
  [0.9, 0.55, 0.2],
]

export class PedestrianSystem {
  private readonly scene: Scene
  private readonly getField: () => { surfaceHeight(x: number, z: number): number; normalAt(x: number, z: number, out: { x: number; y: number; z: number }, eps?: number): void; worldSize: number } | undefined

  private readonly paths: Path[] = []
  private active: Path | null = null
  private readonly walkers: Walker[] = []
  private readonly models = new Map<string, PersonType>()

  private count = 12
  private speed = 1.4 // metres per second
  private playing = false

  private shirtMats: StandardMaterial[] = []
  private skinMat!: StandardMaterial
  private trouserMat!: StandardMaterial
  private readonly obs: () => void
  private seq = 0

  private readonly _n = { x: 0, y: 1, z: 0 }
  private readonly _pos = new Vector3()
  private readonly _tan = new Vector3()
  private readonly _basis = Matrix.Identity()

  constructor(scene: Scene, getField: PedestrianSystem['getField']) {
    this.scene = scene
    this.getField = getField
    this.buildMaterials()
    this.obs = () => this.update()
    this.scene.onBeforeRenderObservable.add(this.obs)
  }

  // -------------------------------------------------------------- path drawing

  beginPath(): void {
    this.cancelPath()
    this.active = { points: [], cum: [], seg: [], total: 0, line: null, markers: [] }
  }

  get drawing(): boolean {
    return this.active !== null
  }

  get activePointCount(): number {
    return this.active?.points.length ?? 0
  }

  addWaypoint(x: number, z: number): void {
    if (!this.active) this.beginPath()
    const y = this.field?.surfaceHeight(x, z) ?? 0
    this.active!.points.push(new Vector3(x, y, z))
    this.redrawActive()
  }

  endPath(): boolean {
    const path = this.active
    if (!path || path.points.length < 2) return false
    this.computeArc(path)
    this.styleLine(path, false)
    this.paths.push(path)
    this.active = null
    this.rebuild()
    return true
  }

  cancelPath(): void {
    if (!this.active) return
    this.disposePath(this.active)
    this.active = null
  }

  clearPaths(): void {
    this.cancelPath()
    for (const p of this.paths) this.disposePath(p)
    this.paths.length = 0
    this.rebuild()
  }

  pathCount(): number {
    return this.paths.length
  }

  // --------------------------------------------------------------------- crowd

  setCount(n: number): void {
    this.count = Math.max(0, Math.min(200, Math.round(n)))
    this.rebuild()
  }

  getCount(): number {
    return this.count
  }

  walkerCount(): number {
    return this.walkers.length
  }

  setSpeed(mps: number): void {
    this.speed = Math.max(0, mps)
  }

  getSpeed(): number {
    return this.speed
  }

  play(): void {
    this.playing = this.paths.length > 0
  }

  pause(): void {
    this.playing = false
  }

  get running(): boolean {
    return this.playing
  }

  // ------------------------------------------------------------ people library

  async addModel(url: string, name: string, ext?: string): Promise<string | null> {
    if (this.models.size >= MAX_PERSON_TYPES) return null
    const loaded = await this.loadTemplate(url, ext)
    if (!loaded) return null
    const id = `personType_${this.seq++}`
    this.models.set(id, {
      id,
      name: name || `شخصية ${this.models.size + 1}`,
      count: 3,
      template: loaded.node,
      tallest: loaded.tallest,
      flip: false,
    })
    this.rebuild()
    return id
  }

  setModelCount(id: string, n: number): void {
    const t = this.models.get(id)
    if (!t) return
    t.count = Math.max(0, Math.min(50, Math.round(n)))
    this.rebuild()
  }

  setModelFlip(id: string, flip: boolean): void {
    const t = this.models.get(id)
    if (!t) return
    t.flip = flip
    this.rebuild()
  }

  removeModel(id: string): void {
    const t = this.models.get(id)
    if (!t) return
    t.template.dispose()
    this.models.delete(id)
    this.rebuild()
  }

  listModels(): { id: string; name: string; count: number; flip: boolean }[] {
    return [...this.models.values()].map((t) => ({ id: t.id, name: t.name, count: t.count, flip: t.flip }))
  }

  // ------------------------------------------------------------------ ground pick

  pickGround(screenX: number, screenY: number): Vector3 | null {
    const field = this.field
    const cam = this.scene.activeCamera
    if (!field || !cam) return null
    const ray = this.scene.createPickingRay(screenX, screenY, null, cam)
    const o = ray.origin
    const d = ray.direction
    const maxT = (field.worldSize ?? 400) * 1.6 + 200
    const step = 1.25
    let prev = o.y - field.surfaceHeight(o.x, o.z)
    for (let s = step; s <= maxT; s += step) {
      const x = o.x + d.x * s
      const z = o.z + d.z * s
      const cur = o.y + d.y * s - field.surfaceHeight(x, z)
      if (prev > 0 && cur <= 0) {
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

  // ----------------------------------------------------------------- per-frame

  private update(): void {
    if (!this.playing || this.walkers.length === 0) return
    const field = this.field
    if (!field) return
    const dt = Math.min(0.05, this.scene.getEngine().getDeltaTime() / 1000)

    for (const w of this.walkers) {
      const path = w.path
      if (path.total <= 0) continue
      const moved = this.speed * w.speedMul * dt
      w.s = (w.s + moved) % path.total
      if (w.s < 0) w.s += path.total
      w.dist += moved

      this.placeWalker(w, field)
      this.animateWalker(w)
    }
  }

  private animateWalker(w: Walker): void {
    const phase = w.dist * GAIT_RATE
    if (w.isModel) {
      // A gentle bob and side-sway so an imported figure reads as walking.
      const bob = Math.abs(Math.sin(phase)) * 0.05
      w.holder.position.y += bob
      const sway = Math.sin(phase) * 0.03
      // meshes[0] is the inner node the model hangs under; sway it, not the
      // holder, so the heading the holder carries is left intact.
      if (w.meshes[0]) w.meshes[0].rotation.z = sway
      return
    }
    const swing = Math.sin(phase) * 0.5
    if (w.legs[0]) w.legs[0].rotation.x = swing
    if (w.legs[1]) w.legs[1].rotation.x = -swing
    // Arms swing opposite to the legs.
    if (w.arms[0]) w.arms[0].rotation.x = -swing
    if (w.arms[1]) w.arms[1].rotation.x = swing
    // A small bob at twice the cadence.
    w.holder.position.y += Math.abs(Math.sin(phase)) * 0.03
  }

  private placeWalker(w: Walker, field: NonNullable<ReturnType<PedestrianSystem['getField']>>): void {
    this.sampleLane(w.path, w.s)
    const gx = this._pos.x
    const gz = this._pos.z
    const gy = field.surfaceHeight(gx, gz)

    field.normalAt(gx, gz, this._n)
    const up = new Vector3(this._n.x, this._n.y, this._n.z)
    if (up.lengthSquared() < 1e-6) up.set(0, 1, 0)
    up.normalize()
    let fwd = new Vector3(this._tan.x, 0, this._tan.z)
    if (fwd.lengthSquared() < 1e-9) fwd.set(0, 0, 1)
    fwd.normalize()
    if (w.flip) fwd.negateInPlace()
    const right = Vector3.Cross(up, fwd)
    right.normalize()
    fwd = Vector3.Cross(right, up)
    fwd.normalize()

    if (!w.holder.rotationQuaternion) w.holder.rotationQuaternion = new Quaternion()
    Matrix.FromValuesToRef(
      right.x, right.y, right.z, 0,
      up.x, up.y, up.z, 0,
      fwd.x, fwd.y, fwd.z, 0,
      0, 0, 0, 1,
      this._basis,
    )
    Quaternion.FromRotationMatrixToRef(this._basis, w.holder.rotationQuaternion)
    w.holder.position.set(gx, gy, gz)
  }

  // ------------------------------------------------------------------ geometry

  private sampleLane(path: Path, s: number): void {
    const n = path.points.length
    let k = 0
    while (k < path.seg.length - 1 && s >= path.cum[k] + path.seg[k]) k++
    const a = path.points[k]
    const b = path.points[(k + 1) % n]
    const len = path.seg[k] || 1e-6
    const f = Math.min(1, Math.max(0, (s - path.cum[k]) / len))
    this._pos.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f)
    this._tan.set(b.x - a.x, 0, b.z - a.z)
  }

  private computeArc(path: Path): void {
    const pts = path.points
    const n = pts.length
    path.cum = []
    path.seg = []
    let total = 0
    for (let i = 0; i < n; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % n]
      const len = Math.hypot(b.x - a.x, b.z - a.z)
      path.cum.push(total)
      path.seg.push(len)
      total += len
    }
    path.total = total
  }

  // -------------------------------------------------------------- walker build

  private rebuild(): void {
    for (const w of this.walkers) this.disposeWalker(w)
    this.walkers.length = 0

    const usable = this.paths.filter((p) => p.total > 1e-3)
    if (usable.length === 0) {
      this.playing = false
      return
    }

    const factories: ((path: Path, idx: number) => Walker)[] = []
    for (let i = 0; i < this.count; i++) factories.push((path, idx) => this.buildFigure(path, idx))
    for (const t of this.models.values()) {
      for (let i = 0; i < t.count; i++) factories.push((path) => this.buildModelWalker(path, t))
    }
    if (factories.length === 0) return

    const perPath: Walker[][] = usable.map(() => [])
    factories.forEach((make, i) => {
      const path = usable[i % usable.length]
      const w = make(path, i)
      this.walkers.push(w)
      perPath[i % usable.length].push(w)
    })

    const field = this.field
    for (let li = 0; li < usable.length; li++) {
      const group = perPath[li]
      const m = group.length
      for (let j = 0; j < m; j++) {
        group[j].s = (usable[li].total * j) / m
        if (field) this.placeWalker(group[j], field)
      }
    }
  }

  /** A generated articulated figure whose limbs swing as it walks. */
  private buildFigure(path: Path, index: number): Walker {
    const id = this.seq++
    const holder = new TransformNode(`ped_${id}`, this.scene)
    holder.rotationQuaternion = new Quaternion()
    const meshes: AbstractMesh[] = []
    const shirt = this.shirtMats[index % this.shirtMats.length]

    const hipY = 0.9
    const torso = MeshBuilder.CreateBox(`ped_torso_${id}`, { width: 0.42, height: 0.6, depth: 0.24 }, this.scene)
    torso.material = shirt
    torso.parent = holder
    torso.position.y = hipY + 0.3
    torso.isPickable = false
    meshes.push(torso)

    const head = MeshBuilder.CreateSphere(`ped_head_${id}`, { diameter: 0.26, segments: 8 }, this.scene)
    head.material = this.skinMat
    head.parent = holder
    head.position.y = hipY + 0.75
    head.isPickable = false
    meshes.push(head)

    const legs: TransformNode[] = []
    for (const side of [-1, 1]) {
      const pivot = new TransformNode(`ped_hip_${id}_${side}`, this.scene)
      pivot.parent = holder
      pivot.position.set(side * 0.12, hipY, 0)
      const leg = MeshBuilder.CreateBox(`ped_leg_${id}_${side}`, { width: 0.16, height: hipY, depth: 0.18 }, this.scene)
      leg.material = this.trouserMat
      leg.parent = pivot
      leg.position.y = -hipY / 2
      leg.isPickable = false
      meshes.push(leg)
      legs.push(pivot)
    }

    const arms: TransformNode[] = []
    const shoulderY = hipY + 0.55
    for (const side of [-1, 1]) {
      const pivot = new TransformNode(`ped_shoulder_${id}_${side}`, this.scene)
      pivot.parent = holder
      pivot.position.set(side * 0.28, shoulderY, 0)
      const arm = MeshBuilder.CreateBox(`ped_arm_${id}_${side}`, { width: 0.12, height: 0.55, depth: 0.14 }, this.scene)
      arm.material = shirt
      arm.parent = pivot
      arm.position.y = -0.275
      arm.isPickable = false
      meshes.push(arm)
      arms.push(pivot)
    }

    return {
      holder,
      legs,
      arms,
      meshes,
      path,
      s: 0,
      speedMul: 0.8 + Math.random() * 0.5,
      dist: Math.random() * 3, // desync the gait
      isModel: false,
      flip: false,
    }
  }

  /** A walker cloned from an uploaded character model. */
  private buildModelWalker(path: Path, type: PersonType): Walker {
    const id = this.seq++
    const holder = new TransformNode(`ped_${id}`, this.scene)
    holder.rotationQuaternion = new Quaternion()
    const inner = new TransformNode(`ped_inner_${id}`, this.scene)
    inner.parent = holder
    const meshes: AbstractMesh[] = [inner as unknown as AbstractMesh]

    const clone = type.template.clone(`ped_modelgeo_${id}`, inner)
    if (clone) {
      clone.setEnabled(true)
      for (const m of clone.getChildMeshes()) {
        m.isPickable = false
        meshes.push(m)
      }
      if (clone instanceof Mesh) meshes.push(clone)
    }
    inner.scaling.setAll(HUMAN_HEIGHT / type.tallest)

    return {
      holder,
      legs: [],
      arms: [],
      meshes,
      path,
      s: 0,
      speedMul: 0.8 + Math.random() * 0.5,
      dist: Math.random() * 3,
      isModel: true,
      flip: type.flip,
    }
  }

  private async loadTemplate(
    url: string,
    ext?: string,
  ): Promise<{ node: TransformNode; tallest: number } | null> {
    try {
      const result = await ImportMeshAsync(url, this.scene, { pluginExtension: ext })
      const meshes = result.meshes.filter((m): m is Mesh => m instanceof Mesh && !!m.getTotalVertices())
      if (meshes.length === 0) {
        for (const m of result.meshes) m.dispose()
        return null
      }
      const template = new TransformNode(`personTemplate_${this.seq++}`, this.scene)
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
      // Re-seat centred on x/z with feet on y = 0.
      for (const m of meshes) {
        m.position.subtractInPlace(new Vector3((min.x + max.x) / 2, min.y, (min.z + max.z) / 2))
      }
      const tallest = Math.max(0.01, max.y - min.y)
      template.setEnabled(false)
      return { node: template, tallest }
    } catch (err) {
      console.error('[pedestrian] could not load character model', url, err)
      return null
    }
  }

  private buildMaterials(): void {
    this.shirtMats = SHIRT_COLORS.map(([r, g, b], i) => {
      const m = new StandardMaterial(`ped_shirt_${i}`, this.scene)
      m.diffuseColor = new Color3(r, g, b)
      m.specularColor = new Color3(0.15, 0.15, 0.15)
      return m
    })
    this.skinMat = new StandardMaterial('ped_skin', this.scene)
    this.skinMat.diffuseColor = new Color3(0.83, 0.66, 0.52)
    this.skinMat.specularColor = new Color3(0.1, 0.1, 0.1)
    this.trouserMat = new StandardMaterial('ped_trouser', this.scene)
    this.trouserMat.diffuseColor = new Color3(0.18, 0.2, 0.26)
    this.trouserMat.specularColor = new Color3(0.1, 0.1, 0.1)
  }

  // ------------------------------------------------------------------- drawing

  private redrawActive(): void {
    if (!this.active) return
    this.styleLine(this.active, true)
    this.drawMarkers(this.active, true)
  }

  private styleLine(path: Path, isActive: boolean): void {
    if (path.line) {
      path.line.dispose()
      path.line = null
    }
    if (path.points.length < 2) return
    const field = this.field
    const lift = 0.18
    const loop = isActive ? path.points : [...path.points, path.points[0]]
    const pts = loop.map((p) => new Vector3(p.x, (field?.surfaceHeight(p.x, p.z) ?? p.y) + lift, p.z))
    const line = MeshBuilder.CreateLines(`ped_path_${this.seq++}`, { points: pts }, this.scene)
    line.color = isActive ? new Color3(0.4, 0.95, 0.55) : new Color3(0.25, 0.8, 0.45)
    line.isPickable = false
    path.line = line
  }

  private drawMarkers(path: Path, isActive: boolean): void {
    for (const m of path.markers) m.dispose()
    path.markers = []
    if (!isActive) return
    const field = this.field
    for (const p of path.points) {
      const dot = MeshBuilder.CreateSphere(`ped_dot_${this.seq++}`, { diameter: 0.5 }, this.scene)
      dot.position.set(p.x, (field?.surfaceHeight(p.x, p.z) ?? p.y) + 0.25, p.z)
      const mat = new StandardMaterial(`ped_dotmat_${this.seq++}`, this.scene)
      mat.emissiveColor = new Color3(0.4, 0.95, 0.55)
      mat.disableLighting = true
      dot.material = mat
      dot.isPickable = false
      path.markers.push(dot)
    }
  }

  // -------------------------------------------------------------------- teardown

  private disposePath(path: Path): void {
    path.line?.dispose()
    path.line = null
    for (const m of path.markers) {
      m.material?.dispose()
      m.dispose()
    }
    path.markers = []
  }

  private disposeWalker(w: Walker): void {
    for (const m of w.meshes) m.dispose()
    for (const l of w.legs) l.dispose()
    for (const a of w.arms) a.dispose()
    w.holder.dispose()
  }

  private get field() {
    return this.getField()
  }

  dispose(): void {
    this.scene.onBeforeRenderObservable.removeCallback(this.obs)
    for (const w of this.walkers) this.disposeWalker(w)
    this.walkers.length = 0
    this.cancelPath()
    for (const p of this.paths) this.disposePath(p)
    this.paths.length = 0
    for (const t of this.models.values()) t.template.dispose()
    this.models.clear()
    for (const m of this.shirtMats) m.dispose()
    this.skinMat?.dispose()
    this.trouserMat?.dispose()
  }
}
