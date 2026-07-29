import {
  Color3,
  Color4,
  HDRCubeTexture,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  StandardMaterial,
  Texture,
  Vector3,
  type AbstractMesh,
  type BaseTexture,
  type IDisposable,
  type Material,
  type Scene,
} from '@babylonjs/core'

/**
 * The Khalidiya road scene.
 *
 * A recreation of the reference photo: a dual carriageway running through the
 * Khalidiya neighbourhood — asphalt with white dashed lanes and yellow edge
 * lines, a raised concrete median with lamp poles, steel guardrails, and
 * sand-coloured buildings set back on both sides.
 *
 * Unlike the first pass, which coloured everything with flat StandardMaterials,
 * this version dresses the scene in real photo-scanned PBR materials (the packs
 * the user uploaded: ground rock, cracked concrete, factory/container walls,
 * rusted metal and shop shutters) and lights it with a real captured sky
 * (an equirectangular HDRI) for image-based lighting. That is as close to
 * photoreal as the web engine gets.
 *
 * It is a self-contained overlay: build() lays real ground over the terrain,
 * drapes the road, raises the buildings and swaps in the HDRI sky + lighting;
 * clear() takes it all back out and restores the sim's own sky.
 */

interface SimLike {
  scene: Scene
  field: { surfaceHeight(x: number, z: number): number; worldSize: number }
  terrain: { tintGround(kind: 'dirt' | 'mud' | 'rock' | 'grass', r: number, g: number, b: number): void }
  vehicle?: { reset(at?: Vector3, yaw?: number): void }
  environment?: {
    applyWeather(kind: 'clear' | 'rain' | 'overcast' | 'snow'): void
    setTimeOfDay(hours: number): void
  }
}

const TEX_BASE = 'textures/khalidiya'

// Colours sampled from the reference photo (used for the painted lane lines and
// as tints over the grey concrete/metal).
const C = {
  white: new Color3(0.86, 0.86, 0.83),
  yellow: new Color3(0.85, 0.63, 0.11),
  sand: [0.8, 0.71, 0.53] as [number, number, number],
  sandDark: [0.74, 0.64, 0.46] as [number, number, number],
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
  private readonly disposables: IDisposable[] = []
  private matCache = new Map<string, PBRMaterial>()

  // Saved scene state, restored on clear().
  private savedEnv: BaseTexture | null = null
  private savedEnvIntensity = 1
  private savedClear: Color4 | null = null
  private prevSkyEnabled: boolean | null = null
  private readonly hidden: { mesh: AbstractMesh; prev: boolean }[] = []

  /**
   * A single flat height the whole scene is built on. The sim's own ground is a
   * mountain valley; Khalidiya is a flat desert town, so we level everything to
   * one plane and hide the valley behind it.
   */
  private flatY: number | null = null

  built = false

  constructor(sim: SimLike) {
    this.sim = sim
    this.scene = sim.scene
  }

  private y(x: number, z: number): number {
    if (this.flatY !== null) return this.flatY
    return this.sim.field.surfaceHeight(x, z)
  }

  // --------------------------------------------------------------- materials

  /**
   * A photo-scanned PBR material: albedo + normal + roughness from one of the
   * uploaded packs, tiled to the given repeat.
   */
  private pbr(
    set: string,
    opts: { tile?: number; tileU?: number; tileV?: number; metallic?: number; tint?: Color3; sheen?: boolean } = {},
  ): PBRMaterial {
    const key = `${set}|${opts.tile}|${opts.tileU}|${opts.tileV}|${opts.metallic}|${opts.tint?.toHexString()}`
    const cached = this.matCache.get(key)
    if (cached) return cached

    const tileU = opts.tileU ?? opts.tile ?? 1
    const tileV = opts.tileV ?? opts.tile ?? 1
    const base = `${TEX_BASE}/${set}`
    const m = new PBRMaterial(`khal_${set}_${this.matCache.size}`, this.scene)

    const albedo = new Texture(`${base}/albedo.jpg`, this.scene)
    albedo.wrapU = albedo.wrapV = Texture.WRAP_ADDRESSMODE
    albedo.uScale = tileU
    albedo.vScale = tileV
    m.albedoTexture = albedo
    if (opts.tint) m.albedoColor = opts.tint

    const normal = new Texture(`${base}/normal.png`, this.scene)
    normal.wrapU = normal.wrapV = Texture.WRAP_ADDRESSMODE
    normal.uScale = tileU
    normal.vScale = tileV
    m.bumpTexture = normal
    m.invertNormalMapY = true // Poly Haven nor_gl reads inverted under Babylon's TBN

    const rough = new Texture(`${base}/rough.jpg`, this.scene)
    rough.wrapU = rough.wrapV = Texture.WRAP_ADDRESSMODE
    rough.uScale = tileU
    rough.vScale = tileV
    m.metallicTexture = rough
    m.useRoughnessFromMetallicTextureGreen = true
    m.useRoughnessFromMetallicTextureAlpha = false
    m.useMetallnessFromMetallicTextureBlue = false
    m.metallic = opts.metallic ?? 0
    m.roughness = 1

    this.disposables.push(albedo, normal, rough, m)
    this.matCache.set(key, m)
    return m
  }

  /** Glossy dark window glass — reflects the HDRI sky so windows read as glass. */
  private glass(): PBRMaterial {
    const m = new PBRMaterial('khal_glass', this.scene)
    m.albedoColor = new Color3(0.02, 0.03, 0.05)
    m.metallic = 0.1
    m.roughness = 0.08
    m.environmentIntensity = 1.2
    this.disposables.push(m)
    return m
  }

  /** Flat unlit paint for the lane lines (bright, ignores shading). */
  private paint(name: string, color: Color3): StandardMaterial {
    const m = new StandardMaterial(`khal_${name}`, this.scene)
    m.diffuseColor = color
    m.emissiveColor = color.scale(0.6)
    m.specularColor = new Color3(0.02, 0.02, 0.02)
    this.disposables.push(m)
    return m
  }

  // ---------------------------------------------------------------- geometry

  /**
   * A flat-across, terrain-following ribbon centred on x, of the given width,
   * lifted `lift` above the ground. `tileV` repeats the texture down its length.
   */
  private ribbon(name: string, centerX: number, width: number, lift: number, mat: Material, tileV = 1): Mesh {
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
    r.receiveShadows = true
    // Repeat the texture down the length instead of stretching it once.
    const uv = r.getVerticesData('uv')
    if (uv) {
      for (let i = 1; i < uv.length; i += 2) uv[i] *= tileV
      r.setVerticesData('uv', uv)
    }
    this.meshes.push(r)
    return r
  }

  /**
   * A subdivided ground sheet that follows the terrain, tiled with a real
   * photo-scanned ground texture. This is the ground the player actually sees
   * up close — sharp rock/dirt instead of the flat sand tint.
   */
  private groundSheet(mat: Material): void {
    // A big flat desert plain at the scene's base height. Large enough that its
    // edges fall into the haze rather than showing a hard border with the sky.
    const half = 520
    const y = this.flatY ?? 0
    const tile = 3.5 // metres per texture repeat
    const ground = MeshBuilder.CreateGround('khal_ground', { width: half * 2, height: half * 2, subdivisions: 8 }, this.scene)
    ground.position.set(0, y - 0.03, 0)
    const uv = ground.getVerticesData('uv')
    if (uv) {
      for (let i = 0; i < uv.length; i++) uv[i] *= (half * 2) / tile
      ground.setVerticesData('uv', uv)
    }
    ground.material = mat
    ground.isPickable = false
    ground.receiveShadows = true
    this.meshes.push(ground)
  }

  /** Short dashes down a lane divider. */
  private dashes(centerX: number, mat: Material): void {
    const dash = 3
    const gap = 6
    for (let z = -HALF_LEN; z <= HALF_LEN - dash; z += dash + gap) {
      const left: Vector3[] = []
      const right: Vector3[] = []
      for (let t = 0; t <= dash + 1e-3; t += dash) {
        const zz = z + t
        const gy = this.y(centerX, zz) + 0.05
        left.push(new Vector3(centerX - 0.09, gy, zz))
        right.push(new Vector3(centerX + 0.09, gy, zz))
      }
      const d = MeshBuilder.CreateRibbon(`khal_dash_${z}`, { pathArray: [left, right] }, this.scene)
      d.material = mat
      d.isPickable = false
      this.meshes.push(d)
    }
  }

  // ------------------------------------------------------------------ sky/IBL

  private installSky(): void {
    const scene = this.scene
    this.savedEnv = scene.environmentTexture
    this.savedEnvIntensity = scene.environmentIntensity
    this.savedClear = scene.clearColor.clone()

    // Real captured sky → image-based lighting + a matching skybox.
    const hdr = new HDRCubeTexture(`${TEX_BASE}/sky_day.hdr`, scene, 512, false, true, false, true)
    scene.environmentTexture = hdr
    scene.environmentIntensity = 1.15
    this.disposables.push(hdr)

    const sky = scene.createDefaultSkybox(hdr, true, 4000, 0.0, false)
    if (sky) {
      sky.isPickable = false
      sky.infiniteDistance = true
      this.meshes.push(sky)
    }

    // The engine's own procedural SkyMaterial box would show through — hide it.
    const proc = scene.getMeshByName('skyBox')
    if (proc) {
      this.prevSkyEnabled = proc.isEnabled()
      proc.setEnabled(false)
    }

    // A light warm haze so the flat plain fades into the sky at the horizon
    // instead of ending on a hard line.
    scene.fogMode = 2 // EXP2
    scene.fogColor = new Color3(0.82, 0.83, 0.83)
    scene.fogDensity = 0.0016
    scene.clearColor = new Color4(0.79, 0.82, 0.86, 1)
  }

  // -------------------------------------------------------------------- build

  private hide(name: string): void {
    const mesh = this.scene.getMeshByName(name)
    if (mesh) {
      this.hidden.push({ mesh, prev: mesh.isEnabled() })
      mesh.setEnabled(false)
    }
  }

  build(): void {
    if (this.built) return
    this.built = true

    // Level everything to one flat plane at the road's base height — Khalidiya is
    // a flat town, not the sim's mountain valley.
    this.flatY = this.sim.field.surfaceHeight(CX, -HALF_LEN + 12)

    // Hide the valley terrain and the scattered conifers/rocks; a flat desert
    // plain and real buildings take their place.
    this.hide('terrain')
    this.hide('treeProto')
    this.hide('rockProto')

    // 0) Bright desert weather + afternoon sun, then real sky + image-based
    //    lighting on top, so every material below is lit by the captured
    //    environment under a warm sun.
    this.sim.environment?.applyWeather('clear')
    this.sim.environment?.setTimeOfDay(15)
    this.installSky()

    // 2) Real photo-scanned ground the player drives on.
    this.groundSheet(this.pbr('ground_rock', { tile: 1, tint: new Color3(1.02, 0.98, 0.9) }))

    // 3) The two carriageways — real cracked-asphalt/concrete, darkened.
    const asphaltMat = this.pbr('concrete', { tileV: 40, tileU: 3, tint: new Color3(0.4, 0.4, 0.42) })
    const whiteMat = this.paint('white', C.white)
    const yellowMat = this.paint('yellow', C.yellow)
    const concreteMat = this.pbr('concrete', { tile: 4, tint: new Color3(0.95, 0.92, 0.85) })
    const railMat = this.pbr('rusty_metal', { tile: 2, metallic: 0.7 })
    const postMat = this.pbr('rusty_metal', { tileV: 1, tileU: 1, metallic: 0.7 })

    for (const side of [-1, 1] as const) {
      const cx = side * CX
      this.ribbon(`carriage_${side}`, cx, CARRIAGE_W, 0.03, asphaltMat, 40)
      this.ribbon(`edgeIn_${side}`, cx - CARRIAGE_W / 2, 0.18, 0.05, yellowMat)
      this.ribbon(`edgeOut_${side}`, cx + CARRIAGE_W / 2, 0.18, 0.05, yellowMat)
      this.dashes(cx - LANE_W / 2, whiteMat)
      this.dashes(cx + LANE_W / 2, whiteMat)
    }

    // 4) Raised concrete median + lamp poles.
    this.ribbon('median', 0, MEDIAN_W, 0.16, concreteMat, 60)
    for (const side of [-1, 1] as const) {
      this.ribbon(`kerb_${side}`, side * (MEDIAN_W / 2), 0.06, 0.09, concreteMat, 60)
    }
    for (let z = -HALF_LEN + 20; z <= HALF_LEN - 20; z += 45) {
      const gy = this.y(0, z)
      const pole = MeshBuilder.CreateCylinder(`khal_pole_${z}`, { diameter: 0.16, height: 6 }, this.scene)
      pole.position.set(0, gy + 3, z)
      pole.material = postMat
      pole.isPickable = false
      this.meshes.push(pole)
    }

    // 5) Steel guardrails down both outer edges.
    for (const side of [-1, 1] as const) {
      const gx = side * (CX + CARRIAGE_W / 2 + 0.6)
      this.ribbon(`rail_${side}`, gx, 0.12, 0.7, railMat, 120)
      for (let z = -HALF_LEN; z <= HALF_LEN; z += 4) {
        const gy = this.y(gx, z)
        const post = MeshBuilder.CreateBox(`khal_post_${side}_${z}`, { width: 0.1, height: 0.75, depth: 0.1 }, this.scene)
        post.position.set(gx, gy + 0.38, z)
        post.material = postMat
        post.isPickable = false
        this.meshes.push(post)
      }
    }

    // 6) Buildings set back on both sides. The uploaded wall packs are all
    //    industrial (green container, rusty iron), so the sandstone body is the
    //    cracked-concrete pack warmed to a beige plaster — the real look of a
    //    Jordanian town — with glass windows upstairs and a metal shop shutter
    //    across the road-facing ground floor.
    const shutterMat = this.pbr('shutter', { tileU: 3, tileV: 1 })
    const glassMat = this.glass()
    // A few sandstone tints so the street isn't one flat colour.
    const beige = [
      new Color3(1.55, 1.4, 1.05),
      new Color3(1.7, 1.5, 1.1),
      new Color3(1.42, 1.32, 1.05),
      new Color3(1.6, 1.38, 0.98),
    ]
    for (let i = 0; i < 40; i++) {
      const side = i % 2 === 0 ? -1 : 1
      const dist = CX + CARRIAGE_W / 2 + 8 + Math.random() * 30
      const x = side * dist
      const z = -HALF_LEN + 30 + Math.random() * (HALF_LEN * 2 - 60)
      const w = 6 + Math.random() * 7
      const d = 6 + Math.random() * 7
      const floors = 2 + Math.floor(Math.random() * 2) // 2–3 storeys
      const floorH = 3.3
      const h = floors * floorH
      const gy = this.y(x, z)

      const wallMat = this.pbr('concrete', {
        tileU: Math.max(1, Math.round(w / 4)),
        tileV: floors,
        tint: beige[i % beige.length],
      })
      const b = MeshBuilder.CreateBox(`khal_house_${i}`, { width: w, height: h, depth: d }, this.scene)
      b.position.set(x, gy + h / 2, z)
      b.material = wallMat
      b.isPickable = false
      this.meshes.push(b)

      // Road-facing face is perpendicular to x; it spans the depth d (in z).
      const faceX = x + (side < 0 ? 1 : -1) * (w / 2 + 0.05)

      // Windows on the upper floors — glossy dark glass reflecting the sky.
      const cols = Math.max(2, Math.round(d / 3))
      const winW = Math.min(1.2, (d / cols) * 0.6)
      for (let f = 1; f < floors; f++) {
        const cy = gy + f * floorH + floorH * 0.5
        for (let c = 0; c < cols; c++) {
          const cz = z - d / 2 + (d * (c + 0.5)) / cols
          const win = MeshBuilder.CreateBox(`khal_win_${i}_${f}_${c}`, { width: 0.08, height: 1.4, depth: winW }, this.scene)
          win.position.set(faceX, cy, cz)
          win.material = glassMat
          win.isPickable = false
          this.meshes.push(win)
        }
      }

      // Metal shop shutter across the road-facing ground floor.
      const shutter = MeshBuilder.CreateBox(`khal_shutter_${i}`, { width: 0.1, height: 2.7, depth: d * 0.82 }, this.scene)
      shutter.position.set(faceX, gy + 1.4, z)
      shutter.material = shutterMat
      shutter.isPickable = false
      this.meshes.push(shutter)
    }

    // 7) Park the player at the near end, looking down the road.
    this.sim.vehicle?.reset(new Vector3(CX, 0, -HALF_LEN + 12), 0)
  }

  clear(): void {
    if (!this.built) return
    this.built = false

    for (const m of this.meshes) m.dispose()
    this.meshes.length = 0
    for (const d of this.disposables) d.dispose()
    this.disposables.length = 0
    this.matCache.clear()
    this.flatY = null

    // Un-hide the valley terrain and scattered props.
    for (const h of this.hidden) h.mesh.setEnabled(h.prev)
    this.hidden.length = 0

    // Restore the sim's own sky + lighting.
    const scene = this.scene
    if (this.savedEnv !== undefined) scene.environmentTexture = this.savedEnv
    scene.environmentIntensity = this.savedEnvIntensity
    if (this.savedClear) scene.clearColor = this.savedClear
    if (this.prevSkyEnabled !== null) {
      const proc = scene.getMeshByName('skyBox')
      proc?.setEnabled(this.prevSkyEnabled)
      this.prevSkyEnabled = null
    }
    this.sim.environment?.applyWeather('overcast')
  }
}
