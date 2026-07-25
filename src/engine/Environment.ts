import {
  Color3,
  Color4,
  CreateBox,
  CreateCylinder,
  CreateIcoSphere,
  DirectionalLight,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  PBRMaterial,
  RawTexture,
  ReflectionProbe,
  CascadedShadowGenerator,
  Matrix,
  Quaternion,
  Scene,
  Texture,
  Vector3,
  VertexBuffer,
} from '@babylonjs/core'
import { SkyMaterial } from '@babylonjs/materials'
import type { MudField } from './MudField'
import type { WeatherKind } from '../store/simStore'
import { fbm, valueNoise2 } from './noise'

interface WeatherProfile {
  turbidity: number
  luminance: number
  fogDensity: number
  fogColor: Color3
  sunIntensity: number
  ambientIntensity: number
  /** Extra wetness added to the ground on top of the humidity slider. */
  wetBias: number
  snow: number
  rainRate: number
}

const PROFILES: Record<WeatherKind, WeatherProfile> = {
  clear: {
    turbidity: 2.6,
    luminance: 1.0,
    fogDensity: 0.0016,
    fogColor: new Color3(0.62, 0.7, 0.8),
    sunIntensity: 5.2,
    ambientIntensity: 0.42,
    wetBias: 0,
    snow: 0,
    rainRate: 0,
  },
  overcast: {
    turbidity: 12,
    luminance: 0.42,
    fogDensity: 0.0062,
    fogColor: new Color3(0.55, 0.58, 0.62),
    sunIntensity: 1.9,
    ambientIntensity: 0.72,
    wetBias: 0.2,
    snow: 0,
    rainRate: 0,
  },
  rain: {
    turbidity: 22,
    luminance: 0.3,
    fogDensity: 0.0115,
    fogColor: new Color3(0.42, 0.45, 0.5),
    sunIntensity: 1.1,
    ambientIntensity: 0.78,
    wetBias: 0.45,
    snow: 0,
    rainRate: 5200,
  },
  snow: {
    turbidity: 9,
    luminance: 0.55,
    fogDensity: 0.0135,
    fogColor: new Color3(0.72, 0.75, 0.8),
    sunIntensity: 2.2,
    ambientIntensity: 0.85,
    wetBias: 0.15,
    snow: 1,
    rainRate: 2600,
  },
}

/** Small radial-gradient sprite for rain/snow particles — no asset file needed. */
function particleSprite(scene: Scene, streak: boolean): RawTexture {
  const s = 32
  const data = new Uint8Array(s * s * 4)
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = (x - s / 2) / (s / 2)
      const dy = (y - s / 2) / (s / 2)
      // Rain is a vertical streak; snow is a round flake.
      const d = streak ? Math.hypot(dx * 3.2, dy * 0.85) : Math.hypot(dx, dy)
      const a = Math.max(0, 1 - d)
      const o = (y * s + x) * 4
      data[o] = 255
      data[o + 1] = 255
      data[o + 2] = 255
      data[o + 3] = (Math.pow(a, streak ? 1.4 : 1.8) * 255) | 0
    }
  }
  const tex = RawTexture.CreateRGBATexture(data, s, s, scene, false, false, Texture.BILINEAR_SAMPLINGMODE)
  tex.name = streak ? 'rainSprite' : 'snowSprite'
  return tex
}

export class Environment {
  readonly sun: DirectionalLight
  readonly ambient: HemisphericLight
  readonly shadows: CascadedShadowGenerator
  readonly skybox: Mesh
  readonly skyMaterial: SkyMaterial
  readonly probe: ReflectionProbe

  private readonly scene: Scene
  private readonly field: MudField
  private rain: ParticleSystem | null = null
  private snow: ParticleSystem | null = null
  private props: Mesh[] = []
  private currentWeather: WeatherKind = 'overcast'
  private probeDirty = true

  /**
   * Multiplier on every weather profile's fog density.
   *
   * The profiles were tuned against a 220 m play area, where they read as
   * atmosphere. Applied unchanged to a 2 km neighbourhood the same numbers are
   * an opaque wall — EXP2 fog at 0.0062 leaves nothing visible past ~400 m, so
   * the far half of the region is a flat grey field. Scaling by the ratio of
   * world sizes keeps the *look* — haze that thickens at the horizon — while
   * putting the horizon where the world actually ends.
   */
  private readonly fogScale: number

  /** Extra ground wetness contributed by the weather, 0..1. */
  wetBias = 0
  /** Snow coverage on the ground, 0..1. */
  snowCover = 0

  constructor(scene: Scene, field: MudField, shadowQuality: number) {
    this.scene = scene
    this.field = field

    scene.clearColor = new Color4(0.55, 0.58, 0.62, 1)
    scene.ambientColor = new Color3(0.35, 0.37, 0.4)

    this.skyMaterial = new SkyMaterial('sky', scene)
    this.skyMaterial.backFaceCulling = false
    this.skyMaterial.useSunPosition = true
    this.skyMaterial.rayleigh = 2.2
    this.skyMaterial.mieCoefficient = 0.006
    this.skyMaterial.mieDirectionalG = 0.82
    this.skyMaterial.disableDepthWrite = true

    this.skybox = CreateBox('skyBox', { size: 4000 }, scene)
    this.skybox.material = this.skyMaterial
    this.skybox.infiniteDistance = true
    this.skybox.isPickable = false
    this.skybox.applyFog = false

    this.sun = new DirectionalLight('sun', new Vector3(-0.45, -0.85, 0.28), scene)
    this.sun.intensity = 3.2
    this.sun.shadowMinZ = 1
    this.sun.shadowMaxZ = 220

    this.ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene)
    this.ambient.intensity = 0.6
    this.ambient.groundColor = new Color3(0.16, 0.13, 0.1)

    this.shadows = new CascadedShadowGenerator(shadowQuality, this.sun)
    this.shadows.numCascades = 4
    this.shadows.lambda = 0.86
    this.shadows.cascadeBlendPercentage = 0.08
    this.shadows.stabilizeCascades = true
    this.shadows.shadowMaxZ = 190
    this.shadows.depthClamp = true
    this.shadows.usePercentageCloserFiltering = true
    this.shadows.filteringQuality = CascadedShadowGenerator.QUALITY_MEDIUM
    this.shadows.bias = 0.008
    this.shadows.normalBias = 0.02

    // Approximate IBL: a probe that bakes the sky and nearby terrain. Not a
    // properly convolved environment map, but it gives wet mud something real
    // to reflect instead of a flat colour.
    this.probe = new ReflectionProbe('envProbe', 128, scene)
    this.probe.renderList!.push(this.skybox)
    this.probe.refreshRate = 0
    scene.environmentTexture = this.probe.cubeTexture
    scene.environmentIntensity = 0.85

    // Square root, not the raw ratio: fog density that fell off linearly with
    // world size would leave a 2 km region looking like vacuum. This thins it
    // by ~3x over 2 km, which still shows the far ridge while keeping distance
    // readable.
    this.fogScale = Math.sqrt(220 / Math.max(220, field.worldSize))

    scene.fogMode = Scene.FOGMODE_EXP2
    scene.fogColor = new Color3(0.55, 0.58, 0.62)
    scene.fogDensity = 0.006 * this.fogScale

    this.applyWeather('overcast')
    this.setTimeOfDay(12)
  }

  // ------------------------------------------------------------------- sun

  /** @param hours 0..24 */
  setTimeOfDay(hours: number) {
    // Sun arc: noon overhead, sunrise at 06:00, sunset at 18:00.
    const t = ((hours - 6) / 12) * Math.PI
    const elevation = Math.sin(t)
    const azimuth = Math.cos(t)
    const dir = new Vector3(azimuth * 0.85, -Math.max(0.06, elevation), 0.35).normalize()
    this.sun.direction = dir

    const sunPos = dir.scale(-1)
    this.skyMaterial.sunPosition = sunPos.scale(100)

    const profile = PROFILES[this.currentWeather]
    // Light dims and warms as the sun drops.
    const day = Math.max(0, elevation)
    const warm = Math.pow(1 - day, 2.2)
    this.sun.intensity = profile.sunIntensity * (0.12 + day * 0.95)
    this.sun.diffuse = Color3.Lerp(
      new Color3(1.0, 0.98, 0.94),
      new Color3(1.0, 0.55, 0.28),
      warm * 0.85,
    )
    this.ambient.intensity = profile.ambientIntensity * (0.22 + day * 0.85)
    this.ambient.diffuse = Color3.Lerp(
      new Color3(0.42, 0.5, 0.68),
      new Color3(0.2, 0.19, 0.26),
      warm,
    )
    this.skyMaterial.luminance = profile.luminance * (0.35 + day * 0.75)
    this.probeDirty = true
  }

  applyWeather(kind: WeatherKind) {
    this.currentWeather = kind
    const p = PROFILES[kind]
    this.skyMaterial.turbidity = p.turbidity
    this.scene.fogDensity = p.fogDensity * this.fogScale
    this.scene.fogColor = p.fogColor.clone()
    this.scene.clearColor = new Color4(p.fogColor.r, p.fogColor.g, p.fogColor.b, 1)
    this.wetBias = p.wetBias
    this.snowCover = p.snow
    this.probeDirty = true

    this.rain?.stop()
    this.snow?.stop()
    if (p.rainRate > 0) {
      const isSnow = kind === 'snow'
      const sys = isSnow ? this.ensureSnow() : this.ensureRain()
      sys.emitRate = p.rainRate
      sys.start()
    }
  }

  private ensureRain(): ParticleSystem {
    if (this.rain) return this.rain
    const ps = new ParticleSystem('rain', 6000, this.scene)
    ps.particleTexture = particleSprite(this.scene, true)
    ps.minSize = 0.035
    ps.maxSize = 0.07
    ps.minScaleY = 9
    ps.maxScaleY = 16
    ps.minLifeTime = 0.55
    ps.maxLifeTime = 0.9
    ps.color1 = new Color4(0.72, 0.78, 0.86, 0.42)
    ps.color2 = new Color4(0.6, 0.66, 0.76, 0.3)
    ps.colorDead = new Color4(0.6, 0.66, 0.76, 0)
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD
    ps.gravity = new Vector3(0, -58, 0)
    ps.direction1 = new Vector3(-1.5, -14, -1.5)
    ps.direction2 = new Vector3(1.5, -20, 1.5)
    ps.minEmitPower = 1
    ps.maxEmitPower = 2
    ps.createBoxEmitter(
      new Vector3(0, -1, 0),
      new Vector3(0, -1, 0),
      new Vector3(-26, 0, -26),
      new Vector3(26, 0, 26),
    )
    this.rain = ps
    return ps
  }

  private ensureSnow(): ParticleSystem {
    if (this.snow) return this.snow
    const ps = new ParticleSystem('snow', 4000, this.scene)
    ps.particleTexture = particleSprite(this.scene, false)
    ps.minSize = 0.05
    ps.maxSize = 0.14
    ps.minLifeTime = 3.5
    ps.maxLifeTime = 6
    ps.color1 = new Color4(1, 1, 1, 0.9)
    ps.color2 = new Color4(0.9, 0.93, 1, 0.7)
    ps.colorDead = new Color4(1, 1, 1, 0)
    ps.gravity = new Vector3(0.6, -2.4, 0.3)
    ps.direction1 = new Vector3(-1.2, -1, -1.2)
    ps.direction2 = new Vector3(1.2, -2, 1.2)
    ps.minEmitPower = 0.4
    ps.maxEmitPower = 1.1
    ps.createBoxEmitter(
      new Vector3(0, -1, 0),
      new Vector3(0, -1, 0),
      new Vector3(-30, 0, -30),
      new Vector3(30, 0, 30),
    )
    this.snow = ps
    return ps
  }

  /** Keep weather emitters and shadow cascades centred on the camera. */
  followCamera(pos: Vector3) {
    for (const ps of [this.rain, this.snow]) {
      if (ps && ps.isStarted()) {
        ps.emitter = new Vector3(pos.x, pos.y + 22, pos.z)
      }
    }
    if (this.probeDirty) {
      this.probe.position = new Vector3(pos.x, pos.y + 6, pos.z)
      this.probe.cubeTexture.refreshRate = 1
      this.probeDirty = false
      // One frame of refresh is enough; drop back to static next tick.
      setTimeout(() => (this.probe.cubeTexture.refreshRate = 0), 60)
    }
  }

  // ----------------------------------------------------------------- props

  /**
   * Scatter rocks and conifers using the same noise field as the terrain, so
   * they land on the valley walls and stay off the drivable corridor.
   * Thin instances keep the whole forest at two draw calls.
   */
  scatterProps(count: number) {
    for (const p of this.props) p.dispose()
    this.props = []
    if (count <= 0) return

    const half = this.field.worldSize * 0.5 - 8

    // ---- rocks ----
    const rock = CreateIcoSphere('rockProto', { radius: 1, subdivisions: 2, flat: true }, this.scene)
    const rp = rock.getVerticesData(VertexBuffer.PositionKind)!
    for (let i = 0; i < rp.length; i += 3) {
      const n = valueNoise2(rp[i] * 2.4, rp[i + 2] * 2.4, 7) * 0.55 + 0.72
      rp[i] *= n * 1.25
      rp[i + 1] *= n * 0.72
      rp[i + 2] *= n * 1.1
    }
    rock.setVerticesData(VertexBuffer.PositionKind, rp)
    rock.createNormals(true)
    const rockMat = new PBRMaterial('rockPropMat', this.scene)
    rockMat.albedoColor = new Color3(0.26, 0.25, 0.245)
    rockMat.roughness = 0.92
    rockMat.metallic = 0
    rock.material = rockMat
    rock.receiveShadows = true
    rock.isPickable = false

    // ---- conifer ----
    const trunk = CreateCylinder('trunk', { height: 3.2, diameterTop: 0.22, diameterBottom: 0.42, tessellation: 6 }, this.scene)
    trunk.position.y = 1.6
    const cones: Mesh[] = [trunk]
    for (let i = 0; i < 3; i++) {
      const c = CreateCylinder(
        `cone${i}`,
        { height: 3.4 - i * 0.7, diameterTop: 0, diameterBottom: 3.2 - i * 0.75, tessellation: 8 },
        this.scene,
      )
      c.position.y = 3.1 + i * 1.55
      cones.push(c)
    }
    const tree = Mesh.MergeMeshes(cones, true, true, undefined, false, false)!
    tree.name = 'treeProto'
    const treeMat = new PBRMaterial('treePropMat', this.scene)
    treeMat.albedoColor = new Color3(0.075, 0.115, 0.062)
    treeMat.roughness = 0.95
    treeMat.metallic = 0
    tree.material = treeMat
    tree.receiveShadows = true
    tree.isPickable = false

    const rockMatrices: Matrix[] = []
    const treeMatrices: Matrix[] = []
    let seed = 1337
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }

    for (let i = 0; i < count; i++) {
      const x = (rnd() * 2 - 1) * half
      const z = (rnd() * 2 - 1) * half
      const y = this.field.baseHeight(x, z)

      // Slope from the base surface — steep ground gets rocks, gentle gets trees.
      const e = 1.5
      const slope = Math.abs(this.field.baseHeight(x + e, z) - this.field.baseHeight(x - e, z)) / (2 * e)

      // Keep the valley corridor clear so there's always a route through.
      if (Math.abs(x - this.field.trackCenterX(z)) < 9) continue

      const density = fbm(x * 0.02, z * 0.02, 3, 2.0, 0.5, 404)
      const isRock = slope > 0.28 || rnd() < 0.34

      if (isRock) {
        const s = 0.35 + rnd() * 1.5
        rockMatrices.push(
          Matrix.Compose(
            new Vector3(s, s * (0.6 + rnd() * 0.5), s * (0.8 + rnd() * 0.5)),
            Quaternion.FromEulerAngles(rnd() * 0.5 - 0.25, rnd() * Math.PI * 2, rnd() * 0.5 - 0.25),
            new Vector3(x, y - s * 0.28, z),
          ),
        )
      } else if (density > 0.42 && slope < 0.5) {
        const s = 0.7 + rnd() * 0.75
        treeMatrices.push(
          Matrix.Compose(
            new Vector3(s, s * (0.85 + rnd() * 0.5), s),
            Quaternion.FromEulerAngles(0, rnd() * Math.PI * 2, 0),
            new Vector3(x, y - 0.25, z),
          ),
        )
      }
    }

    if (rockMatrices.length) {
      rock.thinInstanceAdd(rockMatrices)
      this.shadows.addShadowCaster(rock)
      this.props.push(rock)
    } else rock.dispose()

    if (treeMatrices.length) {
      tree.thinInstanceAdd(treeMatrices)
      this.shadows.addShadowCaster(tree)
      this.props.push(tree)
    } else tree.dispose()
  }

  /** A shallow water plane so the low ground reads as flooded. */
  createWaterPlane(level: number): Mesh {
    const water = MeshBuilder.CreateGround(
      'water',
      { width: this.field.worldSize, height: this.field.worldSize, subdivisions: 1 },
      this.scene,
    )
    water.position.y = level
    water.isPickable = false
    const mat = new PBRMaterial('waterMat', this.scene)
    mat.albedoColor = new Color3(0.045, 0.052, 0.048)
    mat.metallic = 0.05
    mat.roughness = 0.09
    mat.alpha = 0.82
    mat.transparencyMode = PBRMaterial.MATERIAL_ALPHABLEND
    water.material = mat
    return water
  }

  dispose() {
    for (const p of this.props) p.dispose()
    this.rain?.dispose()
    this.snow?.dispose()
    this.probe.dispose()
    this.skybox.dispose()
    this.skyMaterial.dispose()
    /*
     * The lights and their shadow generator have to go too.
     *
     * Leaving them behind is not a slow leak — it breaks rendering on the very
     * next Environment. Babylon expands its per-light shader includes over the
     * lights actually in the scene, and a second sun and hemisphere push past
     * a material's maxSimultaneousLights; the include then fails to expand and
     * the literal `#include<...>` reaches the compiler as a syntax error on
     * `<`. Every affected material falls back to a cruder shader, and the
     * surviving ones are lit twice over.
     */
    this.shadows.dispose()
    this.sun.dispose()
    this.ambient.dispose()
  }
}
