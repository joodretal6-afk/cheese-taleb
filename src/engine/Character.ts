import {
  AbstractMesh,
  AnimationGroup,
  Color3,
  CreateBox,
  CreateCapsule,
  CreateSphere,
  ImportMeshAsync,
  Mesh,
  PBRMaterial,
  Quaternion,
  Scalar,
  TransformNode,
  Vector3,
  type Scene,
} from '@babylonjs/core'
import type { MudField } from './MudField'
import type { Input } from './Input'

/**
 * On-foot player.
 *
 * Kinematic by design: the character is integrated by hand against the same
 * MudField the vehicle's wheels read, rather than being a Rapier body. That
 * keeps one source of truth for the ground — a second collision representation
 * would drift out of register with the deforming mud — and makes slopes, steps
 * and ground-snapping trivial on a heightfield.
 */

export interface CharacterConfig {
  radius: number
  /** Full standing height, metres. */
  height: number
  walkSpeed: number
  runSpeed: number
  /** Peak height of a jump, metres. */
  jumpHeight: number
  /** Ground acceleration, m/s². */
  accel: number
  /** How much steering authority you keep in the air, 0..1. */
  airControl: number
  /** Steepest walkable slope, degrees. */
  maxSlopeDeg: number
}

export const DEFAULT_CHARACTER: CharacterConfig = {
  radius: 0.32,
  height: 1.8,
  walkSpeed: 2.3,
  runSpeed: 5.8,
  jumpHeight: 1.05,
  accel: 26,
  airControl: 0.3,
  maxSlopeDeg: 52,
}

const GRAVITY = 18 // snappier than 9.81; standard for third-person movement

export type CharacterGait = 'idle' | 'walk' | 'run' | 'air'

export class Character {
  readonly config: CharacterConfig
  readonly position = new Vector3()
  readonly velocity = new Vector3()
  /** Facing direction, radians. */
  yaw = 0
  grounded = false
  gait: CharacterGait = 'idle'
  /** 0..1 how deep the feet are in mud — slows movement. */
  mudDrag = 0

  private readonly field: MudField
  private readonly rig: CharacterRig
  /** Accumulated stride phase, drives the walk cycle. */
  private phase = 0
  private coyote = 0

  private readonly _n = { x: 0, y: 1, z: 0 }

  constructor(scene: Scene, field: MudField, config = DEFAULT_CHARACTER) {
    this.field = field
    this.config = config
    this.rig = new CharacterRig(scene, config)
    this.setEnabled(false)
  }

  get root(): TransformNode {
    return this.rig.root
  }

  /** Eye/aim point — what the third-person camera looks at. */
  get lookTarget(): Vector3 {
    return new Vector3(
      this.position.x,
      this.position.y + this.config.height * 0.82,
      this.position.z,
    )
  }

  setEnabled(on: boolean) {
    this.rig.root.setEnabled(on)
  }

  /** Drop the character at a world position, snapped to the ground. */
  placeAt(x: number, z: number, facingYaw = 0) {
    this.position.set(x, this.field.surfaceHeight(x, z), z)
    this.velocity.setAll(0)
    this.yaw = facingYaw
    this.grounded = true
    this.gait = 'idle'
    this.syncVisual()
  }

  /**
   * @param camYaw camera yaw, so W always means "away from the camera"
   * @param blockers oriented boxes the character cannot walk through
   */
  update(dt: number, input: Input, camYaw: number, blockers: OrientedBox[]) {
    const c = this.config

    // --- desired direction, camera relative --------------------------------
    const fx = Math.sin(camYaw + Math.PI)
    const fz = Math.cos(camYaw + Math.PI)
    const rx = fz
    const rz = -fx
    let dx = fx * input.moveForward + rx * input.moveRight
    let dz = fz * input.moveForward + rz * input.moveRight
    const dLen = Math.hypot(dx, dz)
    if (dLen > 1e-4) {
      dx /= dLen
      dz /= dLen
    }

    // Deep mud both slows you and makes you wade rather than run.
    const depth = this.field.depthAt(this.position.x, this.position.z)
    this.mudDrag = Math.min(1, depth / 0.35)
    const mudFactor = 1 - this.mudDrag * 0.55

    const wants = dLen > 1e-4
    const target = (input.running ? c.runSpeed : c.walkSpeed) * mudFactor
    const desiredX = wants ? dx * target : 0
    const desiredZ = wants ? dz * target : 0

    // --- horizontal acceleration -------------------------------------------
    const control = this.grounded ? 1 : c.airControl
    const k = Math.min(1, c.accel * control * dt / Math.max(1, target))
    this.velocity.x += (desiredX - this.velocity.x) * k
    this.velocity.z += (desiredZ - this.velocity.z) * k

    // --- jump ---------------------------------------------------------------
    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt)
    if (input.jump && this.coyote > 0) {
      // v = sqrt(2gh) gives exactly the requested apex.
      this.velocity.y = Math.sqrt(2 * GRAVITY * c.jumpHeight)
      this.grounded = false
      this.coyote = 0
    }

    // --- integrate ----------------------------------------------------------
    this.velocity.y -= GRAVITY * dt
    this.position.x += this.velocity.x * dt
    this.position.y += this.velocity.y * dt
    this.position.z += this.velocity.z * dt

    // --- world bounds -------------------------------------------------------
    const lim = this.field.worldSize * 0.5 - 2
    this.position.x = Scalar.Clamp(this.position.x, -lim, lim)
    this.position.z = Scalar.Clamp(this.position.z, -lim, lim)

    // --- blockers (the truck, mostly) ---------------------------------------
    for (const b of blockers) this.pushOutOf(b)

    // --- ground -------------------------------------------------------------
    const groundY = this.field.surfaceHeight(this.position.x, this.position.z)
    if (this.position.y <= groundY) {
      this.position.y = groundY
      if (this.velocity.y < 0) this.velocity.y = 0
      this.grounded = true

      // Too steep to stand on: slide down the fall line.
      this.field.normalAt(this.position.x, this.position.z, this._n)
      const slopeCos = Math.cos((c.maxSlopeDeg * Math.PI) / 180)
      if (this._n.y < slopeCos) {
        const slide = (slopeCos - this._n.y) * 26
        this.velocity.x += this._n.x * slide * dt
        this.velocity.z += this._n.z * slide * dt
      }
    } else if (this.position.y - groundY > 0.06) {
      this.grounded = false
    }

    // --- facing and gait ----------------------------------------------------
    const speed = Math.hypot(this.velocity.x, this.velocity.z)
    if (wants && speed > 0.25) {
      const targetYaw = Math.atan2(this.velocity.x, this.velocity.z)
      let delta = targetYaw - this.yaw
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2
      this.yaw += delta * Math.min(1, dt * 14)
    }

    this.gait = !this.grounded
      ? 'air'
      : speed < 0.35
        ? 'idle'
        : speed > c.walkSpeed * 1.25
          ? 'run'
          : 'walk'

    // Stride frequency scales with speed so the feet don't skate.
    this.phase += speed * dt * 2.7
    this.syncVisual()
  }

  /** Horizontal push-out from an oriented box. */
  private pushOutOf(b: OrientedBox) {
    const c = this.config
    // Into the box's local frame.
    const px = this.position.x - b.center.x
    const py = this.position.y + c.height * 0.5 - b.center.y
    const pz = this.position.z - b.center.z
    const lx = px * b.right.x + py * b.right.y + pz * b.right.z
    const ly = px * b.up.x + py * b.up.y + pz * b.up.z
    const lz = px * b.forward.x + py * b.forward.y + pz * b.forward.z

    const ex = b.half.x + c.radius
    const ey = b.half.y + c.height * 0.5
    const ez = b.half.z + c.radius
    if (Math.abs(lx) >= ex || Math.abs(ly) >= ey || Math.abs(lz) >= ez) return

    // Escape along the axis with the least overlap; ignore the vertical one so
    // the character walks around the truck rather than being launched onto it.
    const ox = ex - Math.abs(lx)
    const oz = ez - Math.abs(lz)
    let nx = 0
    let nz = 0
    if (ox < oz) nx = Math.sign(lx) * ox
    else nz = Math.sign(lz) * oz

    this.position.x += b.right.x * nx + b.forward.x * nz
    this.position.z += b.right.z * nx + b.forward.z * nz

    // Kill the velocity going into the surface so we don't stick to it.
    const wx = b.right.x * Math.sign(nx || 0) + b.forward.x * Math.sign(nz || 0)
    const wz = b.right.z * Math.sign(nx || 0) + b.forward.z * Math.sign(nz || 0)
    const into = this.velocity.x * wx + this.velocity.z * wz
    if (into < 0) {
      this.velocity.x -= wx * into
      this.velocity.z -= wz * into
    }
  }

  private syncVisual() {
    this.rig.apply(this.position, this.yaw, this.gait, this.phase, this.mudDrag)
  }

  /** Swap in a rigged GLB if the project ships one. */
  async tryLoadModel(scene: Scene, url: string) {
    await this.rig.tryLoadModel(scene, url)
  }

  dispose() {
    this.rig.dispose()
  }
}

/** Oriented bounding box used for character-vs-world collision. */
export interface OrientedBox {
  center: Vector3
  half: Vector3
  right: Vector3
  up: Vector3
  forward: Vector3
}

/**
 * The visible figure.
 *
 * Ships as a procedural articulated body so the character system works with no
 * assets at all — and the limbs animate, so walking and running read clearly.
 * Drop a rigged `character.glb` (a Mixamo export works) into public/models and
 * it takes over, with its own animation clips driven by the same gait state.
 */
class CharacterRig {
  readonly root: TransformNode

  private readonly parts: Record<string, TransformNode> = {}
  private readonly procedural: Mesh[] = []
  private loaded: AbstractMesh[] = []
  private clips: Partial<Record<CharacterGait, AnimationGroup>> = {}
  private activeClip: AnimationGroup | null = null
  private readonly config: CharacterConfig

  constructor(scene: Scene, config: CharacterConfig) {
    this.config = config
    this.root = new TransformNode('character', scene)

    const skin = new PBRMaterial('charSkin', scene)
    skin.albedoColor = new Color3(0.52, 0.36, 0.26)
    skin.roughness = 0.85
    skin.metallic = 0

    const cloth = new PBRMaterial('charCloth', scene)
    cloth.albedoColor = new Color3(0.16, 0.2, 0.3)
    cloth.roughness = 0.92
    cloth.metallic = 0

    const boots = new PBRMaterial('charBoots', scene)
    boots.albedoColor = new Color3(0.09, 0.08, 0.075)
    boots.roughness = 0.95
    boots.metallic = 0

    const h = config.height
    const node = (name: string, parent: TransformNode, y: number) => {
      const n = new TransformNode(name, this.root.getScene())
      n.parent = parent
      n.position.y = y
      this.parts[name] = n
      return n
    }
    const box = (name: string, parent: TransformNode, w: number, ht: number, d: number, y: number, mat: PBRMaterial) => {
      const m = CreateBox(name, { width: w, height: ht, depth: d }, this.root.getScene())
      m.parent = parent
      m.position.y = y
      m.material = mat
      m.isPickable = false
      this.procedural.push(m)
      return m
    }

    // hips → torso → head, with limbs hanging off pivots so they can swing.
    const hips = node('hips', this.root, h * 0.52)
    box('pelvis', hips, 0.3, 0.2, 0.2, 0, cloth)

    const torso = node('torso', hips, 0.1)
    box('chest', torso, 0.4, h * 0.3, 0.22, h * 0.15, cloth)

    const head = node('head', torso, h * 0.32)
    const skull = CreateSphere('skull', { diameter: h * 0.15, segments: 10 }, scene)
    skull.parent = head
    skull.material = skin
    skull.isPickable = false
    this.procedural.push(skull)

    for (const side of [-1, 1] as const) {
      const tag = side < 0 ? 'L' : 'R'
      const shoulder = node(`arm${tag}`, torso, h * 0.26)
      shoulder.position.x = side * 0.24
      box(`upperArm${tag}`, shoulder, 0.11, h * 0.19, 0.11, -h * 0.095, cloth)
      const elbow = node(`elbow${tag}`, shoulder, -h * 0.19)
      box(`foreArm${tag}`, elbow, 0.1, h * 0.17, 0.1, -h * 0.085, skin)

      const hip = node(`leg${tag}`, hips, -0.02)
      hip.position.x = side * 0.11
      box(`thigh${tag}`, hip, 0.14, h * 0.25, 0.15, -h * 0.125, cloth)
      const knee = node(`knee${tag}`, hip, -h * 0.25)
      box(`shin${tag}`, knee, 0.12, h * 0.23, 0.13, -h * 0.115, cloth)
      box(`boot${tag}`, knee, 0.14, 0.1, 0.24, -h * 0.24, boots)
    }
  }

  async tryLoadModel(scene: Scene, url: string) {
    try {
      const res = await ImportMeshAsync(url, scene)
      const meshes = res.meshes.filter((m) => m.getTotalVertices?.() > 0)
      if (!meshes.length) return

      // Normalise height the same way the vehicle loader normalises scale.
      const min = new Vector3(Infinity, Infinity, Infinity)
      const max = new Vector3(-Infinity, -Infinity, -Infinity)
      for (const m of meshes) {
        m.computeWorldMatrix(true)
        const bb = m.getBoundingInfo().boundingBox
        min.minimizeInPlace(bb.minimumWorld)
        max.maximizeInPlace(bb.maximumWorld)
      }
      const modelHeight = max.y - min.y
      const holder = new TransformNode('characterModel', scene)
      holder.parent = this.root
      if (modelHeight > 0.01) {
        const s = this.config.height / modelHeight
        holder.scaling.setAll(s)
        holder.position.y = -min.y * s
      }
      for (const m of meshes) {
        m.setParent(holder)
        m.isPickable = false
      }
      this.loaded = meshes

      // Match clips by name; Mixamo exports vary, so accept substrings.
      const pick = (...names: string[]) =>
        res.animationGroups.find((g) =>
          names.some((n) => g.name.toLowerCase().includes(n)),
        )
      this.clips = {
        idle: pick('idle', 'stand'),
        walk: pick('walk'),
        run: pick('run', 'sprint', 'jog'),
        air: pick('jump', 'fall', 'air'),
      }
      for (const g of res.animationGroups) g.stop()

      // Hide the procedural stand-in once a real model is in.
      for (const m of this.procedural) m.setEnabled(false)
      console.info('[character] using model', url)
    } catch {
      // No model shipped — the procedural figure stays. Not an error.
    }
  }

  apply(position: Vector3, yaw: number, gait: CharacterGait, phase: number, mud: number) {
    this.root.position.copyFrom(position)
    // Sink slightly into deep mud so the feet are not floating on top of a rut.
    this.root.position.y -= mud * 0.12
    if (!this.root.rotationQuaternion) this.root.rotationQuaternion = new Quaternion()
    Quaternion.FromEulerAnglesToRef(0, yaw, 0, this.root.rotationQuaternion)

    if (this.loaded.length) {
      const clip = this.clips[gait] ?? this.clips.idle ?? null
      if (clip && clip !== this.activeClip) {
        this.activeClip?.stop()
        clip.start(true)
        this.activeClip = clip
      }
      return
    }

    // --- procedural walk cycle ---------------------------------------------
    const swing = gait === 'run' ? 0.95 : gait === 'walk' ? 0.62 : 0.05
    const s = Math.sin(phase)
    const c = Math.cos(phase)

    if (gait === 'air') {
      // Tuck: front leg forward, back leg trailing, arms up.
      this.setRot('legL', 0.7)
      this.setRot('legR', -0.35)
      this.setRot('kneeL', -0.9)
      this.setRot('kneeR', -0.5)
      this.setRot('armL', -1.5)
      this.setRot('armR', -1.3)
      this.setRot('elbowL', -0.5)
      this.setRot('elbowR', -0.5)
      this.parts.hips.position.y = this.config.height * 0.52
      return
    }

    this.setRot('legL', s * swing)
    this.setRot('legR', -s * swing)
    // Knees only bend backwards, and most on the recovering leg.
    this.setRot('kneeL', -Math.max(0, -s) * swing * 1.15)
    this.setRot('kneeR', -Math.max(0, s) * swing * 1.15)
    this.setRot('armL', -s * swing * 0.8)
    this.setRot('armR', s * swing * 0.8)
    this.setRot('elbowL', -Math.max(0, s) * swing * 0.5 - 0.15)
    this.setRot('elbowR', -Math.max(0, -s) * swing * 0.5 - 0.15)

    // Torso counter-rotation and the two-per-stride bob.
    this.parts.torso.rotation.y = -s * swing * 0.18
    this.parts.hips.position.y =
      this.config.height * 0.52 - Math.abs(c) * swing * 0.045
    this.parts.hips.rotation.z = s * swing * 0.05
  }

  private setRot(part: string, x: number) {
    const n = this.parts[part]
    if (n) n.rotation.x = x
  }

  dispose() {
    for (const m of this.procedural) m.dispose()
    for (const m of this.loaded) m.dispose()
    this.root.dispose()
  }
}

/** Standing capsule, handy for debugging the collision volume. */
export function debugCapsule(scene: Scene, config: CharacterConfig): Mesh {
  const m = CreateCapsule(
    'charCapsule',
    { radius: config.radius, height: config.height, tessellation: 10 },
    scene,
  )
  m.isPickable = false
  return m
}
