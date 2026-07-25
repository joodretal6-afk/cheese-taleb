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
import {
  DEFAULT_VEHICLE_ID,
  getVehicle,
  validateSpec,
  type VehicleSpec,
} from './vehicleCatalog'
import { Character, type OrientedBox } from './Character'
import { loadOverrides, overrideSummary, type GroundKind, type OverrideManifest } from './assetOverrides'
import { RegionScene } from './region/RegionScene'
import { loadRegion as loadRegionFile, type RegionStats } from './region/loadRegion'
import { buildingBoxes } from './region/collision'
import { DEFAULT_PALETTE, type Palette, type SurfaceKey } from './region/palette'
import type { HeightProvider, RegionData } from './region/types'
import {
  useSim,
  type PlayerMode,
  type SimSettings,
  type TerrainQuality,
} from '../store/simStore'

const WORLD_SIZE = 220
const MUD_RES = 1024
/**
 * Mud texels per side for a baked region. 2048 over 2 km is 98 cm per texel,
 * against 21 cm for the procedural play area.
 *
 * That is the honest trade: a rut is blurrier over a real neighbourhood than
 * over the test valley, because the same budget is spread over 82 times the
 * ground. Going further costs memory quadratically — five Float32 fields plus
 * the RGBA mirror is already ~100 MB at this resolution.
 */
const REGION_MUD_RES = 2048
/** Far plane for a 2 km region; the 220 m valley never needed this much. */
const REGION_MAX_Z = 3200
/** Buildings further than this cannot touch the walking player this frame. */
const BLOCKER_RANGE = 25
const PHYSICS_DT = 1 / 120
const MAX_SUBSTEPS = 5
/** How close to the driver's door you must stand to get in, metres. */
const ENTER_RANGE = 3.2

/** What landscape the world is built on. */
type WorldSpec =
  | { kind: 'procedural' }
  | {
      kind: 'region'
      data: RegionData
      palette: Palette
      buildings: boolean
      onStage?: (stage: string, fraction: number) => void
    }

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
  /** The baked neighbourhood, once one has been loaded. */
  region?: RegionScene
  /** Which car is being driven. Every physics number comes from here. */
  vehicleSpec: VehicleSpec = getVehicle(DEFAULT_VEHICLE_ID)
  /** Which drop-in assets the user supplied, if any. */
  overrides: OverrideManifest = { ground: {}, props: { tree: null, rock: null } }
  /** Whether the player is driving or walking. */
  mode: PlayerMode = 'driving'
  readonly input = new Input()
  /** Neutral input handed to the truck while the player is walking around. */
  private readonly idleInput = new Input()

  /** Building collision, kept in the character controller's own shape. */
  private regionBlockers: OrientedBox[] = []
  private buildingBodies: RAPIER.RigidBody[] = []
  /** Colours currently dressing the region, so a reload keeps the user's work. */
  regionPalette: Palette = DEFAULT_PALETTE
  /** False while the world is being torn down and rebuilt; tick() stands off. */
  private worldReady = false

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
    /*
     * `window.sim` is a public surface, and the natural way to feature-detect a
     * method on it is `const f = sim.loadRegion; if (f) f(...)`. That detaches
     * the method: `this` is undefined inside it and the first field it touches
     * throws "Cannot read properties of undefined". The call sites are written
     * to go through the object, but binding here means the surface cannot be
     * misused that way at all.
     */
    this.loadRegion = this.loadRegion.bind(this)
    this.unloadRegion = this.unloadRegion.bind(this)
    this.applyRegionPalette = this.applyRegionPalette.bind(this)
    this.setVehicle = this.setVehicle.bind(this)
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

    // --- drop-in assets ------------------------------------------------------
    // Probing is silent: a missing file is the normal case, not a failure.
    this.overrides = await loadOverrides(this.scene)
    console.info('[assets]', overrideSummary(this.overrides))
    store.setLoadProgress(0.2)

    // --- camera ------------------------------------------------------------
    this.camera = new UniversalCamera('chase', new Vector3(0, 12, -20), this.scene)
    this.camera.minZ = 0.25
    this.camera.maxZ = 2200
    this.camera.fov = 0.85
    this.scene.activeCamera = this.camera
    this.attachCameraControls()

    // --- vehicle model -----------------------------------------------------
    // Loaded once for the session. Rebuilding the world swaps the landscape
    // under it, not the truck.
    await this.loadVehicleModel(this.vehicleSpec, (f) => store.setLoadProgress(0.2 + f * 0.4))
    store.setLoadProgress(0.62)

    // --- the world itself ---------------------------------------------------
    await this.buildWorld({ kind: 'procedural' }, 0.62, 0.96)

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

  // ----------------------------------------------------------------- vehicle

  /**
   * Import a car's GLB and make it the current rig. The wheel-name hints and
   * the nominal length come from the catalogue, because every export names its
   * parts differently and some arrive in millimetres.
   */
  private async loadVehicleModel(spec: VehicleSpec, onProgress?: (f: number) => void) {
    this.model = await loadVehicle(
      this.scene,
      spec.modelUrl,
      onProgress,
      spec.wheelNameHints,
      spec.targetLengthM,
    )
    this.mudCoat = new MudCoat(this.model)
  }

  /**
   * Swap to another car in the catalogue, keeping the world exactly as it is.
   *
   * Falls back to the current car if the GLB is missing — only the Frontier
   * ships with the app, so selecting one of the others without dropping its
   * model into public/models/ must fail visibly and harmlessly rather than
   * leave the player with no vehicle at all.
   */
  async setVehicle(id: string): Promise<boolean> {
    const spec = getVehicle(id)
    if (spec.id === this.vehicleSpec.id) return true

    const problems = validateSpec(spec)
    if (problems.length) {
      console.warn('[vehicle]', spec.id, problems)
      return false
    }

    const previous = this.model
    const previousMud = this.mudCoat
    try {
      await this.loadVehicleModel(spec)
    } catch (err) {
      console.error('[vehicle] could not load', spec.modelUrl, err)
      this.model = previous
      this.mudCoat = previousMud
      return false
    }

    // Put the new car where the old one was standing, facing the same way.
    const t = this.vehicle.body.translation()
    const r = this.vehicle.body.rotation()
    for (const m of [...previous.bodyMeshes, ...Object.values(previous.wheels).flatMap((w) => w.meshes)]) {
      m.dispose()
    }
    previous.root.dispose()
    this.world.removeRigidBody(this.vehicle.body)

    this.vehicleSpec = spec
    this.vehicle = new Vehicle(
      RAPIER,
      this.world,
      this.field,
      this.model,
      new Vector3(t.x, t.y, t.z),
      spec,
    )
    this.vehicle.body.setRotation(r, true)
    for (const m of [
      ...this.model.bodyMeshes,
      ...Object.values(this.model.wheels).flatMap((w) => w.meshes),
    ]) {
      this.environment.shadows.addShadowCaster(m)
    }
    this.warmup(2)
    this.camSnap = true
    return true
  }

  // ------------------------------------------------------------------- world

  /**
   * Build (or rebuild) everything that depends on the landscape.
   *
   * The engine, scene, camera, truck model and post-processing chain outlive
   * this — they are the application. The field, the ground, the sky, the
   * physics bodies and the two player avatars are the *world*, and swapping a
   * 220 m test valley for a 2 km neighbourhood means replacing all of them at
   * once: MudField's world size is compiled into the terrain shader, so it
   * cannot be resized in place.
   *
   * Order is forced by the data. The region has to be assembled first because
   * its graded height field is what MudField is then built on; the ground mesh
   * needs the field; the lights need the field to size their cascades; and the
   * vehicle needs somewhere flat to be put down, which only the region knows.
   */
  private async buildWorld(spec: WorldSpec, progressFrom = 0, progressTo = 1) {
    const store = useSim.getState()
    const profile = QUALITY[this.appliedQuality]
    const report = (f: number) =>
      store.setLoadProgress(progressFrom + (progressTo - progressFrom) * Math.min(1, Math.max(0, f)))

    this.worldReady = false

    // --- tear the old world down --------------------------------------------
    this.character?.dispose()
    if (this.vehicle) this.world.removeRigidBody(this.vehicle.body)
    for (const body of this.buildingBodies) this.world.removeRigidBody(body)
    this.buildingBodies = []
    this.regionBlockers = []
    this.environment?.dispose()
    this.terrain?.dispose()
    this.region?.dispose()
    this.region = undefined

    // --- landscape ----------------------------------------------------------
    let heightProvider: HeightProvider | undefined
    let worldSize = WORLD_SIZE
    let mudRes = MUD_RES

    if (spec.kind === 'region') {
      const built = await RegionScene.build(this.scene, spec.data, {
        generateBuildings: spec.buildings,
        palette: spec.palette,
        onProgress: (stage, f) => {
          spec.onStage?.(stage, f)
          report(f * 0.5)
        },
      })
      this.region = built
      this.regionPalette = spec.palette
      heightProvider = built.heightField
      worldSize = spec.data.sizeM
      mudRes = REGION_MUD_RES
      this.camera.maxZ = REGION_MAX_Z
      console.info('[region]', built.stats.name, `${built.stats.roadKm} km`, `${built.buildings.length} buildings`)
    } else {
      this.camera.maxZ = 2200
    }

    report(0.55)
    this.field = new MudField({
      worldSize,
      resolution: mudRes,
      seed: 2024,
      heightProvider,
    })

    report(0.68)
    this.terrain = new Terrain(this.scene, this.field, this.appliedQuality)
    for (const [kind, ov] of Object.entries(this.overrides.ground)) {
      this.terrain.replaceGroundTexture(kind as GroundKind, ov.albedo, ov.normalHeight)
    }

    // The ground half of the palette lives on Terrain, not on RegionScene, so
    // it has to be re-applied whenever Terrain is rebuilt.
    if (spec.kind === 'region') this.applyGroundPalette(spec.palette)

    // --- lighting and props ---------------------------------------------------
    report(0.76)
    this.environment = new Environment(this.scene, this.field, profile.shadowMap)
    // A real neighbourhood gets no scattered conifers. What stands between the
    // houses in Al-Khalidiya is what OSM mapped and what the plot inference
    // built, not a procedural forest dropped through the roofs.
    this.environment.scatterProps(spec.kind === 'region' ? 0 : profile.props)
    this.registerShadowCasters()

    // --- physics for the buildings --------------------------------------------
    if (this.region) {
      report(0.82)
      this.addBuildingColliders()
    }

    // --- the two avatars -------------------------------------------------------
    report(0.88)
    const spawn = this.region ? this.regionSpawn() : this.findSpawn()
    this.vehicle = new Vehicle(RAPIER, this.world, this.field, this.model, spawn, this.vehicleSpec)
    if (this.region) this.faceVehicle(this.region.findSpawn().yaw)
    for (const m of [
      ...this.model.bodyMeshes,
      ...Object.values(this.model.wheels).flatMap((w) => w.meshes),
    ]) {
      this.environment.shadows.addShadowCaster(m)
    }
    // Settle onto the springs before the first frame, so it never appears
    // hovering — and so a slow machine doesn't spend its first seconds falling.
    this.worldReady = true
    this.warmup(3.5)

    report(0.94)
    this.character = new Character(this.scene, this.field)
    // Optional: a rigged character.glb takes over from the procedural figure.
    await this.character.tryLoadModel(this.scene, 'models/character.glb')
    for (const m of this.character.root.getChildMeshes()) {
      this.environment.shadows.addShadowCaster(m)
    }
    this.character.placeAt(spawn.x - 2, spawn.z, 0)
    this.character.setEnabled(this.mode === 'onfoot')

    // Make the chase camera jump to the new world instead of flying across it.
    this.camReady = false
    this.camSnap = true
    report(1)
  }

  /**
   * Load a baked region and rebuild the world on it. This is the entry point
   * the dashboard's region panel calls.
   */
  async loadRegion(
    source: string | RegionData,
    palette?: Palette,
    options?: { buildings?: boolean; onStage?: (stage: string, fraction: number) => void },
  ): Promise<void> {
    const store = useSim.getState()
    // No palette given means "keep what is on screen", so reloading a region
    // after a rebuild does not throw away the colours the user chose.
    const dress = palette ?? this.regionPalette
    // A caller holding the parsed file passes it straight in. The dashboard
    // does: it reads the statistics and the attribution before the build
    // starts, and fetching and re-parsing three quarters of a megabyte to
    // learn the same thing twice is pure waste.
    // Relative URL so the packaged file:// desktop build resolves it too.
    const data =
      typeof source === 'string' ? await loadRegionFile(`regions/${source}.json`) : source

    // Rendering has to stop before the meshes it is drawing are disposed.
    this.engine.stopRenderLoop()
    store.setEngineReady(false)
    store.setLoadProgress(0.02)
    try {
      await this.buildWorld({
        kind: 'region',
        data,
        palette: dress,
        buildings: options?.buildings !== false,
        onStage: options?.onStage,
      })
    } finally {
      this.engine.runRenderLoop(() => this.tick())
      store.setLoadProgress(1)
      store.setEngineReady(true)
    }
  }

  /**
   * What actually got built, for the dashboard to report.
   *
   * The panel can compute statistics from the file on its own, but two of them
   * come out wrong that way. The building count in the file is the number OSM
   * surveyed — one — while the number standing in the scene is two and a half
   * thousand. And the steepest gradient measured on the raw satellite grid is
   * 40%, while the road the player actually drives was graded down to 29%.
   * Reporting the file would be describing something other than the world.
   */
  regionInfo(): { stats: RegionStats; buildings: number; surfaces: SurfaceKey[] } | null {
    if (!this.region) return null
    return {
      stats: this.region.stats,
      buildings: this.region.buildings.length,
      // The ground three are always live: Terrain owns them and Terrain always
      // exists, whatever classes of road the region happens to contain.
      surfaces: [
        ...this.region.activeSurfaceKeys(),
        'ground:bare',
        'ground:rock',
        'ground:vegetation',
      ],
    }
  }

  /** Recolour and re-texture the region without rebuilding a single vertex. */
  applyRegionPalette(palette: Palette): void {
    this.regionPalette = palette
    this.region?.applyPalette(palette)
    this.applyGroundPalette(palette)
  }

  /**
   * The three ground entries in the palette.
   *
   * RegionScene owns the roads and the buildings, but not the ground — that is
   * Terrain's procedural shader, which existed long before regions did and is
   * shared with the mud valley. So these three keys have to be applied here, or
   * they do nothing at all, which is exactly what they did before this.
   *
   * A key left at its default colour is put back to the generated texture
   * rather than tinted to an almost-identical one, so an untouched palette
   * leaves the ground looking exactly as it was authored.
   */
  private applyGroundPalette(palette: Palette): void {
    if (!this.terrain) return
    const MAP: [SurfaceKey, GroundKind][] = [
      ['ground:bare', 'dirt'],
      ['ground:rock', 'rock'],
      ['ground:vegetation', 'grass'],
    ]
    for (const [key, kind] of MAP) {
      const style = palette[key] ?? DEFAULT_PALETTE[key]
      // A user-supplied image wins over any colour: it is the real surface.
      if (style.textureUrl) {
        const tex = new Texture(style.textureUrl, this.scene)
        this.terrain.replaceGroundTexture(kind, tex, null, style.tileMetres)
        continue
      }
      // Drop-in files from public/textures/ are the user's art too — do not
      // paint over one just because the palette carries a default colour.
      if (this.overrides.ground[kind]) continue
      if (style.color.toLowerCase() === DEFAULT_PALETTE[key].color.toLowerCase()) {
        this.terrain.resetGroundTint(kind)
        continue
      }
      const c = Color3.FromHexString(style.color)
      this.terrain.tintGround(kind, c.r, c.g, c.b)
    }
  }

  /** Go back to the procedural mud valley the simulator ships with. */
  async unloadRegion(): Promise<void> {
    if (!this.region) return
    const store = useSim.getState()
    this.engine.stopRenderLoop()
    store.setEngineReady(false)
    store.setLoadProgress(0.02)
    try {
      await this.buildWorld({ kind: 'procedural' })
    } finally {
      this.engine.runRenderLoop(() => this.tick())
      store.setLoadProgress(1)
      store.setEngineReady(true)
    }
  }

  /** Sun and moon shadows for whatever the region put on the ground. */
  private registerShadowCasters() {
    // Roads are pointedly not casters: a ribbon lying 12 cm above the ground it
    // follows casts nothing but acne onto itself.
    for (const mesh of [this.region?.buildingMesh, this.region?.mappedBuildingMesh]) {
      if (mesh) this.environment.shadows.addShadowCaster(mesh)
    }
  }

  /**
   * Give every building a static box collider and a matching blocker for the
   * character controller, so a house stops the truck and the player alike
   * instead of being scenery they drive through.
   */
  private addBuildingColliders() {
    const region = this.region
    if (!region) return
    const boxes = buildingBoxes(region.buildings, (x, z) => this.field.baseHeight(x, z))

    for (const b of boxes) {
      const half = b.height * 0.5
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(b.cx, b.baseY + half, b.cz)
          // Yaw about +Y. Same convention as everywhere else: the angle turns
          // +Z toward +X, which is what atan2(x, z) measures.
          .setRotation({ x: 0, y: Math.sin(b.rot * 0.5), z: 0, w: Math.cos(b.rot * 0.5) }),
      )
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(b.hx, half, b.hz).setFriction(0.7).setRestitution(0.02),
        body,
      )
      this.buildingBodies.push(body)

      // The character controller works in oriented boxes rather than in Rapier,
      // so the same footprint goes in twice, in two different shapes.
      const s = Math.sin(b.rot)
      const c = Math.cos(b.rot)
      this.regionBlockers.push({
        center: new Vector3(b.cx, b.baseY + half, b.cz),
        half: new Vector3(b.hx, half, b.hz),
        right: new Vector3(s, 0, c),
        up: new Vector3(0, 1, 0),
        forward: new Vector3(-c, 0, s),
      })
    }
  }

  /** Buildings close enough to matter to the walking player this frame. */
  private nearbyBlockers(): OrientedBox[] {
    const out: OrientedBox[] = [this.vehicleBox()]
    if (this.regionBlockers.length === 0) return out
    const p = this.character.position
    const r2 = BLOCKER_RANGE * BLOCKER_RANGE
    for (const b of this.regionBlockers) {
      const dx = b.center.x - p.x
      const dz = b.center.z - p.z
      if (dx * dx + dz * dz <= r2) out.push(b)
    }
    return out
  }

  /** Drop the truck on the street the region picked out for it. */
  private regionSpawn(): Vector3 {
    const at = this.region!.findSpawn()
    const { top } = this.footprint(at.x, at.z)
    return new Vector3(at.x, top + this.model.wheels.FL.radius + 0.36, at.z)
  }

  private faceVehicle(yaw: number) {
    this.vehicle.body.setRotation(
      { x: 0, y: Math.sin(yaw * 0.5), z: 0, w: Math.cos(yaw * 0.5) },
      true,
    )
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
      awd: this.vehicleSpec.drivetrain.awd,
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
    // worldReady is false while buildWorld is between disposing the old world
    // and finishing the new one. Nothing in here would survive that gap.
    if (this.disposed || !this.worldReady) return
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
        awd: this.vehicleSpec.drivetrain.awd,
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
        this.character.update(dt, this.input, this.camYaw, this.nearbyBlockers())
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
      this.environment.scatterProps(this.region ? 0 : profile.props)
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
    this.worldReady = false
    this.engine?.stopRenderLoop()
    this.region?.dispose()
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
