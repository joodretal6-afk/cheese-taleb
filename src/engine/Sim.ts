import {
  Color3,
  Color4,
  DefaultRenderingPipeline,
  Engine,
  ImageProcessingConfiguration,
  PBRMaterial,
  Quaternion,
  Scene,
  SSAO2RenderingPipeline,
  Scalar,
  Texture,
  UniversalCamera,
  Vector3,
} from '@babylonjs/core'
import RAPIER from '@dimforge/rapier3d-compat'
import { MudField } from './MudField'
import { Terrain } from './Terrain'
import { Environment } from './Environment'
import { Input } from './Input'
import { Vehicle } from './Vehicle'
import { loadVehicle, MudCoat, type LoadedVehicle } from './VehicleModel'
import { Character, type OrientedBox } from './Character'
import { loadOverrides, overrideSummary, type GroundKind, type OverrideManifest } from './assetOverrides'
import {
  useSim,
  type PlayerMode,
  type SimSettings,
  type TerrainQuality,
} from '../store/simStore'

const WORLD_SIZE = 220
const MUD_RES = 1024
const PHYSICS_DT = 1 / 120
const MAX_SUBSTEPS = 5
/** How close to the driver's door you must stand to get in, metres. */
const ENTER_RANGE = 3.2

interface QualityProfile {
  shadowMap: number
  props: number
  ssao: boolean
  hardwareScale: number
}

const QUALITY: Record<TerrainQuality, QualityProfile> = {
  low: { shadowMap: 1024, props: 700, ssao: false, hardwareScale: 1.25 },
  medium: { shadowMap: 1536, props: 1600, ssao: false, hardwareScale: 1 },
  high: { shadowMap: 2048, props: 3000, ssao: true, hardwareScale: 1 },
  ultra: { shadowMap: 3072, props: 5000, ssao: true, hardwareScale: 1 },
}

/**
 * Owns the render loop and stitches the subsystems together. The React layer
 * only ever touches `boot()`, `dispose()` and the zustand store.
 */
export class Sim {
  readonly canvas: HTMLCanvasElement
  engine!: Engine
  scene!: Scene
  camera!: UniversalCamera
  field!: MudField
  terrain!: Terrain
  environment!: Environment
  vehicle!: Vehicle
  model!: LoadedVehicle
  mudCoat!: MudCoat
  character!: Character
  /** Which drop-in assets the user supplied, if any. */
  overrides: OverrideManifest = { ground: {}, props: { tree: null, rock: null } }
  /** Whether the player is driving or walking. */
  mode: PlayerMode = 'driving'
  readonly input = new Input()
  /** Neutral input handed to the truck while the player is walking around. */
  private readonly idleInput = new Input()

  private world!: RAPIER.World
  private pipeline?: DefaultRenderingPipeline
  private ssao?: SSAO2RenderingPipeline
  private accumulator = 0
  private frame = 0
  private telemetryClock = 0
  private disposed = false
  private unsubscribe?: () => void
  private appliedQuality: TerrainQuality = 'high'

  // Chase camera state.
  private camYaw = Math.PI
  private camPitch = 0.22
  private camDist = 9.5
  private readonly camPos = new Vector3()
  private readonly camTarget = new Vector3()
  private dragging = false
  private camReady = false
  private camSnap = false
  private lastPointer = { x: 0, y: 0 }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
  }

  async boot() {
    const store = useSim.getState()
    const quality = store.settings.terrainQuality
    this.appliedQuality = quality
    const profile = QUALITY[quality]

    this.engine = new Engine(this.canvas, true, {
      preserveDrawingBuffer: false,
      stencil: false,
      antialias: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    })
    this.engine.setHardwareScalingLevel(profile.hardwareScale)

    this.scene = new Scene(this.engine)
    this.scene.clearColor = new Color4(0.55, 0.58, 0.62, 1)
    this.scene.useRightHandedSystem = false
    this.scene.skipPointerMovePicking = true
    this.scene.autoClearDepthAndStencil = true

    store.setLoadProgress(0.05)

    // --- physics world -----------------------------------------------------
    await RAPIER.init()
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    this.world.timestep = PHYSICS_DT

    // --- terrain -----------------------------------------------------------
    this.field = new MudField({ worldSize: WORLD_SIZE, resolution: MUD_RES, seed: 2024 })
    store.setLoadProgress(0.3)
    this.terrain = new Terrain(this.scene, this.field, quality)
    store.setLoadProgress(0.45)

    // --- drop-in assets ------------------------------------------------------
    // Probing is silent: a missing file is the normal case, not a failure.
    this.overrides = await loadOverrides(this.scene)
    for (const [kind, ov] of Object.entries(this.overrides.ground)) {
      this.terrain.replaceGroundTexture(kind as GroundKind, ov.albedo, ov.normalHeight)
    }
    console.info('[assets]', overrideSummary(this.overrides))

    // --- environment -------------------------------------------------------
    this.environment = new Environment(this.scene, this.field, profile.shadowMap)
    this.environment.scatterProps(profile.props)
    // The probe's cube IS scene.environmentTexture, and the terrain material
    // samples it — putting the terrain in the probe's render list closes a
    // framebuffer/texture feedback loop. Sky only.
    store.setLoadProgress(0.55)

    // --- camera ------------------------------------------------------------
    this.camera = new UniversalCamera('chase', new Vector3(0, 12, -20), this.scene)
    this.camera.minZ = 0.25
    this.camera.maxZ = 2200
    this.camera.fov = 0.85
    this.scene.activeCamera = this.camera
    this.attachCameraControls()

    // --- vehicle -----------------------------------------------------------
    this.model = await loadVehicle(this.scene, 'models/frontier.glb', (f) =>
      store.setLoadProgress(0.55 + f * 0.35),
    )
    store.setLoadProgress(0.92)

    for (const m of [...this.model.bodyMeshes, ...Object.values(this.model.wheels).flatMap((w) => w.meshes)]) {
      this.environment.shadows.addShadowCaster(m)
    }
    this.mudCoat = new MudCoat(this.model)

    const spawn = this.findSpawn()
    this.vehicle = new Vehicle(RAPIER, this.world, this.field, this.model, spawn)
    // Settle onto the springs before the first frame, so it never appears
    // hovering — and so a slow machine doesn't spend its first seconds falling.
    this.warmup(3.5)

    // --- on-foot player ------------------------------------------------------
    this.character = new Character(this.scene, this.field)
    // Optional: a rigged character.glb takes over from the procedural figure.
    await this.character.tryLoadModel(this.scene, 'models/character.glb')
    for (const m of this.character.root.getChildMeshes()) {
      this.environment.shadows.addShadowCaster(m)
    }
    this.character.placeAt(spawn.x - 2, spawn.z, 0)
    this.character.setEnabled(false)

    // --- post processing ---------------------------------------------------
    this.buildPipeline(profile)

    this.input.attach(window)
    this.subscribeSettings()

    // Apply whatever the dashboard already had set before boot finished.
    this.applySettings(useSim.getState().settings, true)

    store.setLoadProgress(1)
    store.setEngineReady(true)

    this.engine.runRenderLoop(() => this.tick())
    window.addEventListener('resize', this.onResize)
  }

  /** Ground height range under the vehicle's footprint at (x, z). */
  private footprint(x: number, z: number): { top: number; spread: number } {
    const he = this.model.halfExtents
    let top = -Infinity
    let low = Infinity
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const h = this.field.surfaceHeight(x + i * he.x, z + j * he.z)
        if (h > top) top = h
        if (h < low) low = h
      }
    }
    return { top, spread: top - low }
  }

  /**
   * Pick the flattest spot along the valley track to start on. Dropping the
   * truck onto a slope makes it slide or roll before the player touches
   * anything, and starting it high enough to clear a rise means a long fall.
   */
  private findSpawn(): Vector3 {
    let best: { pos: Vector3; spread: number } | null = null
    for (let z = -70; z <= -10; z += 2.5) {
      const x = this.field.trackCenterX(z)
      const { top, spread } = this.footprint(x, z)
      if (!best || spread < best.spread) {
        best = { pos: new Vector3(x, top, z), spread }
      }
    }
    const pos = best!.pos
    // Wheel centre at rest sits (radius + rest length) below the chassis origin;
    // add a little so the springs settle downwards rather than punching through.
    pos.y += this.model.wheels.FL.radius + 0.36
    return pos
  }

  /**
   * Advance physics with no rendering. Used to settle the suspension at boot and
   * available to the harness, which runs far below real time on software GL.
   */
  warmup(seconds: number) {
    const s = useSim.getState().settings
    const tune = {
      mudIntensity: s.mudIntensity,
      humidity: Math.min(1, s.humidity + this.environment.wetBias),
      ambientC: -10 + s.temperature * 55,
      awd: true,
    }
    const steps = Math.min(2000, Math.floor(seconds / PHYSICS_DT))
    for (let i = 0; i < steps; i++) {
      this.vehicle.step(PHYSICS_DT, this.input, tune)
      this.world.step()
    }
    this.vehicle.syncVisuals()
  }

  private buildPipeline(profile: QualityProfile) {
    if (profile.ssao) {
      this.ssao = new SSAO2RenderingPipeline('ssao', this.scene, { ssaoRatio: 0.6, blurRatio: 1 }, [
        this.camera,
      ])
      this.ssao.radius = 2.4
      this.ssao.totalStrength = 1.15
      this.ssao.expensiveBlur = true
      this.ssao.samples = 12
      this.ssao.maxZ = 130
    }

    const p = new DefaultRenderingPipeline('post', true, this.scene, [this.camera])
    p.samples = 4
    p.fxaaEnabled = true
    p.bloomEnabled = true
    p.bloomThreshold = 0.78
    p.bloomWeight = 0.28
    p.bloomKernel = 48
    p.bloomScale = 0.5
    p.imageProcessingEnabled = true
    p.imageProcessing.toneMappingEnabled = true
    p.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES
    p.imageProcessing.exposure = 1.15
    p.imageProcessing.contrast = 1.18
    p.imageProcessing.vignetteEnabled = true
    p.imageProcessing.vignetteWeight = 2.2
    p.imageProcessing.vignetteStretch = 0.35
    p.sharpenEnabled = true
    p.sharpen.edgeAmount = 0.22
    p.grainEnabled = true
    p.grain.intensity = 4.5
    p.grain.animated = true
    this.pipeline = p
  }

  // ------------------------------------------------------------------ camera

  private attachCameraControls() {
    const c = this.canvas
    c.addEventListener('pointerdown', (e) => {
      this.dragging = true
      this.lastPointer = { x: e.clientX, y: e.clientY }
      c.setPointerCapture(e.pointerId)
    })
    c.addEventListener('pointerup', (e) => {
      this.dragging = false
      c.releasePointerCapture(e.pointerId)
    })
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging) return
      this.camYaw -= (e.clientX - this.lastPointer.x) * 0.005
      this.camPitch = Scalar.Clamp(this.camPitch + (e.clientY - this.lastPointer.y) * 0.004, -0.25, 1.15)
      this.lastPointer = { x: e.clientX, y: e.clientY }
    })
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        this.camDist = Scalar.Clamp(this.camDist + Math.sign(e.deltaY) * 0.9, 3.5, 32)
      },
      { passive: false },
    )
    // Clicking the viewport should give it keyboard focus for driving.
    c.tabIndex = 0
  }

  private updateCamera(dt: number) {
    // The camera follows whatever the player is currently controlling. On foot
    // it sits closer and lower, and never auto-swings behind the direction of
    // travel — strafing round an object should not spin the view.
    const onFoot = this.mode === 'onfoot'
    const body = this.vehicle.body
    const bt = body.translation()
    const bv = body.linvel()

    const t = onFoot
      ? { x: this.character.position.x, y: this.character.position.y, z: this.character.position.z }
      : { x: bt.x, y: bt.y, z: bt.z }
    const v = onFoot
      ? { x: this.character.velocity.x, y: 0, z: this.character.velocity.z }
      : { x: bv.x, y: bv.y, z: bv.z }
    const speed = Math.hypot(v.x, v.z)
    const eye = onFoot ? this.character.config.height * 0.78 : 1.15
    const lift = onFoot ? 0.9 : 2.4
    const baseDist = onFoot ? Math.min(this.camDist, 5.2) : this.camDist

    // First frame: snap instead of lerping from the origin. Letting the smoothed
    // position and target start equal makes TargetCamera.setTarget build a
    // degenerate look-at, which zeroes its internal reference point *permanently*
    // — the camera then renders nothing for the rest of the session.
    if (!this.camReady) {
      this.camReady = true
      this.camTarget.copyFromFloats(t.x, t.y + eye, t.z)
      const cp0 = Math.cos(this.camPitch)
      this.camPos.copyFromFloats(
        t.x + Math.sin(this.camYaw) * cp0 * baseDist,
        t.y + lift + Math.sin(this.camPitch) * baseDist,
        t.z + Math.cos(this.camYaw) * cp0 * baseDist,
      )
    }

    // Ease the camera behind the direction of travel when driving.
    if (!onFoot && !this.dragging && speed > 2.2) {
      const travelYaw = Math.atan2(v.x, v.z) + Math.PI
      let delta = travelYaw - this.camYaw
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2
      this.camYaw += delta * Math.min(1, dt * 1.6)
    }

    const dist = baseDist + (onFoot ? 0 : Math.min(4.5, speed * 0.18))
    const cp = Math.cos(this.camPitch)
    const desiredX = t.x + Math.sin(this.camYaw) * cp * dist
    const desiredZ = t.z + Math.cos(this.camYaw) * cp * dist
    const desiredY = t.y + lift + Math.sin(this.camPitch) * dist

    // Don't let the camera drop under the ground.
    const groundY = this.field.surfaceHeight(desiredX, desiredZ) + (onFoot ? 0.5 : 1.1)
    const clampedY = Math.max(desiredY, groundY)

    // Snap rather than glide when the player just swapped between the truck and
    // walking — easing across a 3 m jump looks like the camera slid off.
    const k = this.camSnap ? 1 : Math.min(1, dt * 7)
    this.camSnap = false
    this.camPos.x += (desiredX - this.camPos.x) * k
    this.camPos.y += (clampedY - this.camPos.y) * k
    this.camPos.z += (desiredZ - this.camPos.z) * k

    this.camTarget.x += (t.x - this.camTarget.x) * k
    this.camTarget.y += (t.y + eye - this.camTarget.y) * k
    this.camTarget.z += (t.z - this.camTarget.z) * k

    this.camera.position.copyFrom(this.camPos)
    // Never hand setTarget a point on top of the camera — see the note above.
    if (Vector3.DistanceSquared(this.camPos, this.camTarget) < 0.25) {
      this.camTarget.z += 1
    }
    this.camera.setTarget(this.camTarget)

    // Speed-sensitive FOV adds a sense of pace without touching the geometry.
    const targetFov = 0.85 + (onFoot ? 0 : Math.min(0.16, speed * 0.006))
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 3)
  }

  // ------------------------------------------------------------ enter / exit

  /** Driver's door in world space — the point you get in and out at. */
  private doorPoint(): Vector3 {
    const t = this.vehicle.body.translation()
    const r = this.vehicle.body.rotation()
    const q = new Quaternion(r.x, r.y, r.z, r.w)
    // Left side of the cab, a step out from the sill.
    const local = new Vector3(-(this.model.halfExtents.x + 0.75), 0, 0.6)
    local.applyRotationQuaternionInPlace(q)
    return new Vector3(t.x + local.x, t.y, t.z + local.z)
  }

  /** The truck as an oriented box, so the character can't walk through it. */
  private vehicleBox(): OrientedBox {
    const t = this.vehicle.body.translation()
    const r = this.vehicle.body.rotation()
    const q = new Quaternion(r.x, r.y, r.z, r.w)
    const right = new Vector3(1, 0, 0)
    const up = new Vector3(0, 1, 0)
    const forward = new Vector3(0, 0, 1)
    right.applyRotationQuaternionInPlace(q)
    up.applyRotationQuaternionInPlace(q)
    forward.applyRotationQuaternionInPlace(q)
    const he = this.model.halfExtents
    const centre = new Vector3(t.x, t.y, t.z).add(up.scale(1.0))
    return {
      center: centre,
      half: new Vector3(he.x * 0.92, 0.85, he.z * 0.94),
      right,
      up,
      forward,
    }
  }

  private distanceToVehicle(): number {
    const p = this.character.position
    const d = this.doorPoint()
    return Math.hypot(p.x - d.x, p.z - d.z)
  }

  /** Toggle between driving and walking. Returns true if the mode changed. */
  toggleVehicle(): boolean {
    if (this.mode === 'driving') {
      const door = this.doorPoint()
      // Step out beside the door, on top of whatever the ground is doing there.
      this.character.placeAt(door.x, door.z, this.characterYawFromVehicle() + Math.PI * 0.5)
      this.character.setEnabled(true)
      this.mode = 'onfoot'
      this.camSnap = true
      return true
    }
    // Only get in if we're actually standing next to the door.
    if (this.distanceToVehicle() > ENTER_RANGE) return false
    this.character.setEnabled(false)
    this.mode = 'driving'
    this.camSnap = true
    return true
  }

  private characterYawFromVehicle(): number {
    const r = this.vehicle.body.rotation()
    const q = new Quaternion(r.x, r.y, r.z, r.w)
    const fwd = new Vector3(0, 0, 1)
    fwd.applyRotationQuaternionInPlace(q)
    return Math.atan2(fwd.x, fwd.z)
  }

  // -------------------------------------------------------------------- loop

  private tick() {
    if (this.disposed) return
    const dtRaw = this.engine.getDeltaTime() / 1000
    // A long stall (tab switch, shader compile) must not fast-forward the sim.
    const dt = Math.min(0.05, dtRaw)
    const settings = useSim.getState().settings

    this.input.update(dt)
    if (this.input.consumePress('KeyR')) this.vehicle.reset()
    if (settings.running && this.input.consumePress('KeyF')) this.toggleVehicle()

    const onFoot = this.mode === 'onfoot'

    if (settings.running) {
      this.accumulator += dt
      let steps = 0
      const tune = {
        mudIntensity: settings.mudIntensity,
        humidity: Math.min(1, settings.humidity + this.environment.wetBias),
        ambientC: -10 + settings.temperature * 55,
        awd: true,
      }
      // A parked truck still needs stepping so it settles and stays put, but it
      // must not react to the keys the player is walking around with.
      const vehicleInput = onFoot ? this.idleInput : this.input
      while (this.accumulator >= PHYSICS_DT && steps < MAX_SUBSTEPS) {
        this.vehicle.step(PHYSICS_DT, vehicleInput, tune)
        this.world.step()
        this.accumulator -= PHYSICS_DT
        steps++
      }
      if (steps === MAX_SUBSTEPS) this.accumulator = 0

      if (onFoot) {
        this.character.update(dt, this.input, this.camYaw, [this.vehicleBox()])
      }

      this.field.relax(dt, tune.humidity, this.frame)
    }

    this.vehicle.syncVisuals()
    this.terrain.syncMudTexture()
    this.updateCamera(dt)
    this.environment.followCamera(this.camera.position)

    // Live shader params.
    const wet = Math.min(1, settings.humidity + this.environment.wetBias)
    this.terrain.humidity = wet
    this.terrain.mudIntensity = settings.mudIntensity
    this.terrain.snow = this.environment.snowCover
    this.terrain.wetGloss = wet

    const tel = this.vehicle.getTelemetry()
    this.mudCoat.set(tel.bodyMud, wet)

    this.telemetryClock += dt
    if (this.telemetryClock >= 0.1) {
      this.telemetryClock = 0
      useSim.getState().pushTelemetry({
        fps: Math.round(this.engine.getFps()),
        speedKmh: Math.round(tel.speedKmh),
        rpm: Math.round(tel.rpm),
        gear: settings.running ? tel.gearLabel : 'P',
        awd: tel.awd,
        enginePct: Math.round(tel.enginePct),
        fuelPct: Math.round(tel.fuelPct),
        damagePct: Math.round(tel.damagePct),
        engineTempC: Math.round(tel.engineTempC),
        wheelSink: tel.wheelSink,
        bodyMud: tel.bodyMud,
        mode: this.mode,
        footSpeedKmh: onFoot
          ? Math.round(
              Math.hypot(this.character.velocity.x, this.character.velocity.z) * 3.6,
            )
          : 0,
        canEnterVehicle: onFoot && this.distanceToVehicle() <= ENTER_RANGE,
      })
    }

    this.frame++
    this.scene.render()
  }

  // ---------------------------------------------------------------- settings

  private subscribeSettings() {
    let prev = useSim.getState().settings
    this.unsubscribe = useSim.subscribe((state) => {
      const s = state.settings
      if (s === prev) return
      this.applySettings(s, false, prev)
      prev = s
    })
  }

  private applySettings(s: SimSettings, force: boolean, prev?: SimSettings) {
    if (force || !prev || s.weather !== prev.weather) {
      this.environment.applyWeather(s.weather)
    }
    if (force || !prev || s.timeOfDay !== prev.timeOfDay) {
      this.environment.setTimeOfDay(s.timeOfDay)
    }
    if (s.terrainQuality !== this.appliedQuality) {
      this.appliedQuality = s.terrainQuality
      const profile = QUALITY[s.terrainQuality]
      this.terrain.setQuality(s.terrainQuality)
      this.environment.scatterProps(profile.props)
      this.engine.setHardwareScalingLevel(profile.hardwareScale)
      for (const m of [
        ...this.model.bodyMeshes,
        ...Object.values(this.model.wheels).flatMap((w) => w.meshes),
      ]) {
        this.environment.shadows.addShadowCaster(m)
      }
      if (profile.ssao && !this.ssao) {
        this.ssao = new SSAO2RenderingPipeline('ssao', this.scene, { ssaoRatio: 0.6, blurRatio: 1 }, [
          this.camera,
        ])
      } else if (!profile.ssao && this.ssao) {
        this.ssao.dispose()
        this.ssao = undefined
      }
    }
  }

  // -------------------------------------------------------------- part tools

  private allVehicleMeshes() {
    // The dashboard can call these before boot() has loaded the model.
    if (!this.model) return []
    return [
      ...this.model.bodyMeshes,
      ...Object.values(this.model.wheels).flatMap((w) => w.meshes),
    ]
  }

  private meshesForPart(partId: string) {
    const part = useSim.getState().parts.find((p) => p.id === partId)
    if (!part) return []
    return this.allVehicleMeshes().filter((m) =>
      part.meshHints.some((h) => m.name.includes(h)),
    )
  }

  /**
   * Paint a generated texture onto a part. It goes in as the albedo map, so the
   * live mud coating (which drives albedoColor) still tints it as the truck gets
   * dirty rather than being overwritten.
   */
  applyPartTexture(partId: string, url: string) {
    const meshes = this.meshesForPart(partId)
    if (!meshes.length) return 0
    const tex = new Texture(url, this.scene, true, false)
    tex.name = `generated_${partId}`
    for (const m of meshes) {
      const mat = m.material
      if (mat instanceof PBRMaterial) {
        mat.albedoTexture?.dispose()
        mat.albedoTexture = tex
      }
    }
    return meshes.length
  }

  /**
   * Paint a texture onto the ground — a user file or a map derived from their
   * own photo. `tileMetres` is how much ground one repeat covers, so a photo of
   * a 2 m patch of dirt tiles at its true scale instead of an arbitrary one.
   *
   * Returns 1 on success, 0 if the engine isn't ready, so the UI can report it.
   */
  applyGroundTexture(url: string, tileMetres = 2, kind: GroundKind = 'dirt'): number {
    if (!this.terrain) return 0
    const tex = new Texture(url, this.scene, false, false)
    tex.name = `photo_${kind}`
    this.terrain.replaceGroundTexture(kind, tex, null, tileMetres)
    return 1
  }

  /** Tint the selected part so the dashboard selection is visible in 3D. */
  highlightPart(partId: string | null) {
    for (const m of this.allVehicleMeshes()) {
      const mat = m.material
      if (mat instanceof PBRMaterial) mat.emissiveColor = Color3.Black()
    }
    if (!partId) return
    for (const m of this.meshesForPart(partId)) {
      const mat = m.material
      if (mat instanceof PBRMaterial) mat.emissiveColor = new Color3(0.06, 0.09, 0.22)
    }
  }

  // ----------------------------------------------------------------- teardown

  private onResize = () => this.engine?.resize()

  dispose() {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('resize', this.onResize)
    this.unsubscribe?.()
    this.input.detach(window)
    this.engine?.stopRenderLoop()
    this.pipeline?.dispose()
    this.ssao?.dispose()
    this.character?.dispose()
    this.environment?.dispose()
    this.terrain?.dispose()
    this.scene?.dispose()
    this.engine?.dispose()
    useSim.getState().setEngineReady(false)
  }
}
