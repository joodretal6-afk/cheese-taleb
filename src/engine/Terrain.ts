import {
  Color3,
  Material,
  Mesh,
  RawTexture,
  Texture,
  Vector4,
  VertexData,
  type Scene,
  type ThinEngine,
} from '@babylonjs/core'
import { PBRCustomMaterial } from '@babylonjs/materials'
import { MAX_DEPTH, MAX_RIDGE, type MudField } from './MudField'
import { createGroundLibrary, type GroundLibrary } from './proceduralTextures'
import type { TerrainQuality } from '../store/simStore'
import type { GroundKind } from './assetOverrides'

/** Shader sampler names backing each ground material. */
const GROUND_SAMPLERS: Record<GroundKind, { albedo: string; normal: string | null }> = {
  dirt: { albedo: 'dirtTex', normal: 'dirtNH' },
  mud: { albedo: 'mudTexA', normal: 'mudNH' },
  rock: { albedo: 'rockTex', normal: 'rockNH' },
  grass: { albedo: 'grassTex', normal: null },
}

/** Mesh vertices per side for each quality tier. */
const MESH_SEGMENTS: Record<TerrainQuality, number> = {
  low: 192,
  medium: 320,
  high: 448,
  ultra: 640,
}

/**
 * The drivable ground.
 *
 * Geometry carries the static landscape; the mud layer is applied on the GPU
 * from MudField's RGBA texture — displacement in the vertex stage for the broad
 * sinking, and per-pixel normal/albedo/roughness work in the fragment stage for
 * the rut detail that the mesh is too coarse to resolve.
 */
export class Terrain {
  readonly mesh: Mesh
  readonly material: PBRCustomMaterial
  readonly mudTexture: RawTexture
  readonly library: GroundLibrary

  private readonly scene: Scene
  private readonly field: MudField
  /** Reused tint buffers, one per ground kind — see tintGround. */
  private readonly tinted = new Map<GroundKind, Uint8Array>()

  // Bound by reference into the shader; mutated each frame from the dashboard.
  private readonly mudParams = new Vector4(0, 0, 0.7, 0.85)
  private readonly envParams = new Vector4(0, 0, 0, 0)
  // Per-kind ground tiling multiplier (x=dirt y=rock z=grass). 1 = default.
  private readonly groundScales = new Vector4(1, 1, 1, 1)

  // Live values pushed in from the dashboard each frame.
  humidity = 0.7
  mudIntensity = 0.85
  snow = 0
  wetGloss = 0
  /** 0 = normal shading; 1..9 visualise a single shader channel. */
  debugMode = 0
  /**
   * Multiplier on the ground UV scale. 1 keeps the procedural tiling the shader
   * was authored around; a photo-derived texture sets it from its real-world
   * size so a 2 m wall repeats every 2 m.
   */
  tileScale = 1

  constructor(scene: Scene, field: MudField, quality: TerrainQuality) {
    this.scene = scene
    this.field = field
    this.library = createGroundLibrary(scene, 512)

    this.mudTexture = RawTexture.CreateRGBATexture(
      field.pixels,
      field.res,
      field.res,
      scene,
      false, // no mipmaps — we sub-upload every frame
      false,
      Texture.BILINEAR_SAMPLINGMODE,
    )
    this.mudTexture.name = 'mudField'
    this.mudTexture.wrapU = Texture.CLAMP_ADDRESSMODE
    this.mudTexture.wrapV = Texture.CLAMP_ADDRESSMODE

    this.mesh = new Mesh('terrain', scene)
    this.buildGeometry(MESH_SEGMENTS[quality])

    this.material = this.buildMaterial()
    this.mesh.material = this.material
    this.mesh.receiveShadows = true
    // Rays are traced analytically against MudField, never against this mesh.
    this.mesh.isPickable = false
    this.mesh.alwaysSelectAsActiveMesh = true
  }

  /** Rebuild at a new density when the quality dropdown changes. */
  setQuality(quality: TerrainQuality) {
    this.buildGeometry(MESH_SEGMENTS[quality])
  }

  private buildGeometry(segments: number) {
    const size = this.field.worldSize
    const half = size / 2
    const step = size / segments
    const vcount = (segments + 1) * (segments + 1)

    const positions = new Float32Array(vcount * 3)
    const normals = new Float32Array(vcount * 3)
    const uvs = new Float32Array(vcount * 2)
    const indices = new Uint32Array(segments * segments * 6)

    for (let z = 0; z <= segments; z++) {
      const wz = z * step - half
      for (let x = 0; x <= segments; x++) {
        const wx = x * step - half
        const i = z * (segments + 1) + x
        positions[i * 3] = wx
        positions[i * 3 + 1] = this.field.baseHeight(wx, wz)
        positions[i * 3 + 2] = wz
        uvs[i * 2] = x / segments
        uvs[i * 2 + 1] = z / segments
      }
    }

    // Normals from the *base* surface; the mud layer perturbs them per-pixel.
    for (let z = 0; z <= segments; z++) {
      const wz = z * step - half
      for (let x = 0; x <= segments; x++) {
        const wx = x * step - half
        const i = z * (segments + 1) + x
        const hL = this.field.baseHeight(wx - step, wz)
        const hR = this.field.baseHeight(wx + step, wz)
        const hD = this.field.baseHeight(wx, wz - step)
        const hU = this.field.baseHeight(wx, wz + step)
        let nx = hL - hR
        let ny = 2 * step
        let nz = hD - hU
        const inv = 1 / Math.hypot(nx, ny, nz)
        normals[i * 3] = nx * inv
        normals[i * 3 + 1] = ny * inv
        normals[i * 3 + 2] = nz * inv
      }
    }

    let o = 0
    for (let z = 0; z < segments; z++) {
      for (let x = 0; x < segments; x++) {
        const a = z * (segments + 1) + x
        const b = a + 1
        const c = a + segments + 1
        const d = c + 1
        // Winding matters: Babylon is left-handed, and the opposite order leaves
        // the whole ground back-facing and therefore invisible from above.
        indices[o++] = a
        indices[o++] = b
        indices[o++] = c
        indices[o++] = b
        indices[o++] = d
        indices[o++] = c
      }
    }

    const data = new VertexData()
    data.positions = positions as unknown as number[]
    data.normals = normals as unknown as number[]
    data.uvs = uvs as unknown as number[]
    data.indices = indices as unknown as number[]
    data.applyToMesh(this.mesh, false)
  }

  private buildMaterial(): PBRCustomMaterial {
    const mat = new PBRCustomMaterial('terrainMat', this.scene)
    mat.metallic = 0
    mat.roughness = 1
    mat.albedoColor = new Color3(1, 1, 1)
    mat.specularIntensity = 0.55
    mat.backFaceCulling = true
    // The custom albedo path drives colour entirely; a base map would fight it.
    mat.albedoTexture = null

    const worldSize = this.field.worldSize
    const texel = 1 / this.field.res

    // Values are handed to AddUniform directly so PBRCustomMaterial's own
    // AttachAfterBind does the binding. Doing it from onBindObservable instead
    // does not work here: PBRCustomMaterial._afterBind wraps the super call —
    // which is what notifies that observable — in a bare try/catch, so the
    // callback silently never runs and every sampler reads as white.
    // The two vec4s are bound by reference, so mutating them updates the shader.
    const lib = this.library
    mat.AddUniform('mudTex', 'sampler2D', this.mudTexture)
    mat.AddUniform('dirtTex', 'sampler2D', lib.dirt.albedo)
    mat.AddUniform('dirtNH', 'sampler2D', lib.dirt.normalHeight)
    mat.AddUniform('mudTexA', 'sampler2D', lib.mud.albedo)
    mat.AddUniform('mudNH', 'sampler2D', lib.mud.normalHeight)
    mat.AddUniform('rockTex', 'sampler2D', lib.rock.albedo)
    mat.AddUniform('rockNH', 'sampler2D', lib.rock.normalHeight)
    mat.AddUniform('grassTex', 'sampler2D', lib.grass.albedo)
    // x=worldSize y=texel z=humidity w=mudIntensity
    this.mudParams.set(worldSize, texel, this.humidity, this.mudIntensity)
    mat.AddUniform('uMudParams', 'vec4', this.mudParams)
    // x=snow y=wetGloss z=debugMode w=tileScale
    this.envParams.w = this.tileScale
    mat.AddUniform('uEnvParams', 'vec4', this.envParams)
    // Per-kind tiling multiplier: x=dirt y=rock z=grass (w spare). 1 = the
    // scale the shader was authored around, so the default look is untouched;
    // the size slider drives these so each ground can be sized on its own.
    mat.AddUniform('uGroundScales', 'vec4', this.groundScales)

    const shared = /* glsl */ `
      #define MUD_MAX_DEPTH ${MAX_DEPTH.toFixed(4)}
      #define MUD_MAX_RIDGE ${MAX_RIDGE.toFixed(4)}
      #define MUD_WORLD ${worldSize.toFixed(2)}

      vec2 mudUvFromWorld(vec2 wxz) {
        return wxz / MUD_WORLD + 0.5;
      }
    `

    mat.Vertex_Definitions(shared)

    // Displace the static landscape by the mud layer. positionUpdated is in the
    // ground mesh's local space, which is world space here (mesh sits at origin).
    mat.Vertex_Before_PositionUpdated(/* glsl */ `
      vec2 mUv = mudUvFromWorld(positionUpdated.xz);
      vec4 mSample = texture2D(mudTex, mUv);
      positionUpdated.y += -mSample.r * MUD_MAX_DEPTH + mSample.g * MUD_MAX_RIDGE;
    `)

    mat.Fragment_Definitions(/* glsl */ `
      ${shared}

      // Height of the mud layer relative to the undisturbed surface.
      float mudOffset(vec2 wxz) {
        vec4 s = texture2D(mudTex, mudUvFromWorld(wxz));
        return -s.r * MUD_MAX_DEPTH + s.g * MUD_MAX_RIDGE;
      }

      vec3 blendGround(vec2 wxz, float slope, float wet, float disturb, float depth,
                       out float roughOut) {
        // Three tiling scales stop the eye from locking onto one repeat.
        // uEnvParams.w rescales all of them together when a real texture with a
        // known physical size replaces the procedural one.
        float ts = max(0.02, uEnvParams.w);
        vec2 uvFar  = wxz * 0.035 * ts;
        vec2 uvMid  = wxz * 0.155 * ts;
        vec2 uvNear = wxz * 0.62 * ts;

        // Per-kind size. mud keeps the authored scale; the three palette-editable
        // grounds each take their own multiplier so a photo can be sized to fit.
        float sD = max(0.02, uGroundScales.x);
        float sR = max(0.02, uGroundScales.y);
        float sG = max(0.02, uGroundScales.z);
        vec3 dirt = texture2D(dirtTex, uvMid * sD).rgb * 0.72
                  + texture2D(dirtTex, uvFar * sD).rgb * 0.28;
        vec3 mud  = texture2D(mudTexA, uvMid).rgb * 0.65
                  + texture2D(mudTexA, uvNear).rgb * 0.35;
        vec3 rock = texture2D(rockTex, uvMid * 0.6 * sR).rgb;
        vec3 grass = texture2D(grassTex, uvMid * sG).rgb;

        // Rock takes over on anything steep.
        float rockMix = smoothstep(0.42, 0.78, slope);
        // Grass survives only where it is flat and undisturbed. Note the edges
        // must be increasing — smoothstep with edge0 > edge1 is undefined in
        // GLSL and silently returns garbage on some drivers.
        float grassMix = (1.0 - rockMix) * (1.0 - smoothstep(0.18, 0.55, slope))
                       * (1.0 - smoothstep(0.0, 0.45, disturb));

        vec3 base = mix(dirt, grass, grassMix);
        base = mix(base, rock, rockMix);

        // Churned ground turns to mud.
        float mudMix = clamp(disturb * 0.85 + depth * 2.2, 0.0, 1.0) * (1.0 - rockMix * 0.75);
        vec3 col = mix(base, mud, mudMix);

        // Wet mud darkens sharply and goes glossy — the classic wet-soil look.
        float wetness = clamp(mudMix * wet + depth * 1.8 * wet, 0.0, 1.0);
        col *= mix(1.0, 0.42, wetness);

        // Standing water pooling in the deepest ruts.
        float pool = smoothstep(0.28, 0.55, depth / MUD_MAX_DEPTH) * wet;
        col = mix(col, vec3(0.055, 0.05, 0.042), pool * 0.8);

        roughOut = mix(mix(0.95, 0.78, mudMix), 0.12, wetness * 0.85 + pool * 0.15);
        return col;
      }
    `)

    // NOTE: the albedo and metallic/roughness hooks are injected *inside*
    // albedoOpacityBlock / reflectivityBlock, where main()'s `normalW` is out of
    // scope. Only globals are usable there, hence vNormalW.
    mat.Fragment_Custom_Albedo(/* glsl */ `
      vec2 wxz = vPositionW.xz;
      vec4 mS = texture2D(mudTex, mudUvFromWorld(wxz));
      float slope = 1.0 - clamp(normalize(vNormalW).y, 0.0, 1.0);
      float rough;
      vec3 ground = blendGround(wxz, slope, uMudParams.z, mS.b, mS.r * MUD_MAX_DEPTH, rough);

      // Tread bars carved by the tyres read as dark grooves.
      ground *= 1.0 - mS.a * 0.42;

      // Snow settles on flat, undisturbed ground (increasing smoothstep edges).
      float snow = uEnvParams.x * (1.0 - smoothstep(0.15, 0.55, slope)) * (1.0 - mS.b * 0.9);
      ground = mix(ground, vec3(0.82, 0.85, 0.9), snow);

      // Channel inspector, driven from the dashboard/console. 0 = off.
      int dbg = int(uEnvParams.z + 0.5);
      if (dbg == 1) ground = vec3(slope);
      else if (dbg == 2) ground = vec3(mS.b);
      else if (dbg == 3) ground = vec3(mS.r);
      else if (dbg == 4) ground = texture2D(dirtTex, wxz * 0.155).rgb;
      else if (dbg == 5) ground = texture2D(grassTex, wxz * 0.155).rgb;
      else if (dbg == 6) ground = texture2D(rockTex, wxz * 0.093).rgb;
      else if (dbg == 7) ground = normalize(vNormalW) * 0.5 + 0.5;
      else if (dbg == 8) ground = vec3(snow);
      else if (dbg == 9) ground = texture2D(mudTexA, wxz * 0.155).rgb;

      result = ground;
    `)

    // This hook injects verbatim (no `result` alias) and writes straight to the
    // in-scope vec2: .r is metallic, .g is roughness.
    mat.Fragment_Custom_MetallicRoughness(/* glsl */ `
      {
        vec2 wxz2 = vPositionW.xz;
        vec4 mS2 = texture2D(mudTex, mudUvFromWorld(wxz2));
        float slope2 = 1.0 - clamp(normalize(vNormalW).y, 0.0, 1.0);
        float rough2;
        blendGround(wxz2, slope2, uMudParams.z, mS2.b, mS2.r * MUD_MAX_DEPTH, rough2);
        metallicRoughness.r = 0.0;
        metallicRoughness.g = clamp(rough2, 0.06, 1.0);
      }
    `)

    // Per-pixel normals: mud-layer gradient (rut walls and berms) plus the
    // tiling detail normal. The mesh is far too coarse to show either.
    mat.Fragment_Before_Lights(/* glsl */ `
      vec2 wp = vPositionW.xz;
      float e = MUD_WORLD * ${texel.toFixed(8)} * 1.0;
      float hL = mudOffset(wp - vec2(e, 0.0));
      float hR = mudOffset(wp + vec2(e, 0.0));
      float hD = mudOffset(wp - vec2(0.0, e));
      float hU = mudOffset(wp + vec2(0.0, e));
      vec3 mudN = normalize(vec3((hL - hR), 2.0 * e, (hD - hU)));

      vec4 dn = texture2D(dirtNH, wp * 0.155);
      vec4 mn = texture2D(mudNH, wp * 0.62);
      vec4 rn = texture2D(rockNH, wp * 0.093);
      vec4 mudS = texture2D(mudTex, mudUvFromWorld(wp));
      float slopeN = 1.0 - clamp(normalW.y, 0.0, 1.0);
      float rockW = smoothstep(0.42, 0.78, slopeN);
      float mudW = clamp(mudS.b * 0.85 + mudS.r * 1.2, 0.0, 1.0);

      vec3 detail = mix(dn.xyz, mn.xyz, mudW);
      detail = mix(detail, rn.xyz, rockW);
      detail = detail * 2.0 - 1.0;

      // Tread grooves add a directional bump on top of the detail.
      detail.xy += vec2(0.0, mudS.a * 0.55 - 0.275);

      // Blend: mesh normal, then mud-layer shape, then fine detail.
      vec3 n = normalize(normalW + (mudN - vec3(0.0, 1.0, 0.0)) * 2.4);
      vec3 tangent = normalize(cross(vec3(0.0, 1.0, 0.0), n) + vec3(0.0001, 0.0, 0.0));
      vec3 bitan = cross(n, tangent);
      float strength = mix(0.55, 0.9, mudW);
      normalW = normalize(n + (tangent * detail.x + bitan * detail.y) * strength);
    `)

    return mat
  }

  /**
   * Swap one of the four ground materials for a real texture — a user-supplied
   * file (assetOverrides) or a map built from their own photo (photo pipeline).
   *
   * PBRCustomMaterial binds custom samplers from `_newSamplerInstances`, keyed
   * `"<kind>-<name>"`, and re-reads that map on every bind. Replacing the entry
   * is therefore the supported way to change a bound texture after the material
   * has been built; there is no public setter for a custom uniform.
   *
   * @param tileMetres how many metres one repeat of the texture covers, so a
   *   photo of a 2 m wall tiles at its true size instead of an arbitrary one.
   */
  replaceGroundTexture(
    kind: GroundKind,
    albedo: Texture,
    normalHeight?: Texture | null,
    tileMetres?: number,
  ) {
    const slots = GROUND_SAMPLERS[kind]
    const instances = (this.material as unknown as {
      _newSamplerInstances?: Record<string, Texture>
    })._newSamplerInstances
    if (!instances) return

    albedo.wrapU = Texture.WRAP_ADDRESSMODE
    albedo.wrapV = Texture.WRAP_ADDRESSMODE
    instances[`sampler2D-${slots.albedo}`] = albedo

    if (normalHeight && slots.normal) {
      normalHeight.wrapU = Texture.WRAP_ADDRESSMODE
      normalHeight.wrapV = Texture.WRAP_ADDRESSMODE
      instances[`sampler2D-${slots.normal}`] = normalHeight
    }

    if (tileMetres && tileMetres > 0) this.setGroundTileMetres(kind, tileMetres)
    // Force a re-bind so the change shows without waiting for a define change.
    this.material.markAsDirty(Material.TextureDirtyFlag)
  }

  /** Index into groundScales for the three palette-editable grounds. */
  private static readonly SCALE_INDEX: Partial<Record<GroundKind, 'x' | 'y' | 'z'>> = {
    dirt: 'x',
    rock: 'y',
    grass: 'z',
  }

  /** Authored metres-per-repeat for each ground, so tileMetres maps to reality. */
  private static readonly BASE_TILE: Partial<Record<GroundKind, number>> = {
    // 1/0.155 ≈ 6.45 m is the mid scale the shader samples at; each ground's
    // "natural" size is expressed relative to that so the slider is honest.
    dirt: 6.45,
    rock: 10.75, // rock samples at uvMid*0.6, so its natural repeat is larger
    grass: 6.45,
  }

  /**
   * Set how many metres one repeat of a ground texture covers. Smaller = the
   * image appears smaller and repeats more often, which is what "shrink it"
   * means. mud is not adjustable — it is the churn overlay, not a surface.
   */
  setGroundTileMetres(kind: GroundKind, metres: number) {
    const axis = Terrain.SCALE_INDEX[kind]
    const base = Terrain.BASE_TILE[kind]
    if (!axis || !base || !(metres > 0)) return
    this.groundScales[axis] = base / metres
  }

  /** Current per-kind tiling multiplier. Inspection hook for the harness. */
  groundScaleOf(kind: GroundKind): number {
    const axis = Terrain.SCALE_INDEX[kind]
    return axis ? this.groundScales[axis] : 1
  }

  /** Put a ground sampler back to its procedural texture and default size. */
  restoreGroundTexture(kind: GroundKind) {
    const slots = GROUND_SAMPLERS[kind]
    const instances = (this.material as unknown as {
      _newSamplerInstances?: Record<string, Texture>
    })._newSamplerInstances
    if (!instances) return
    instances[`sampler2D-${slots.albedo}`] = this.library[kind].albedo
    if (slots.normal) instances[`sampler2D-${slots.normal}`] = this.library[kind].normalHeight
    const axis = Terrain.SCALE_INDEX[kind]
    if (axis) this.groundScales[axis] = 1
    this.material.markAsDirty(Material.TextureDirtyFlag)
  }

  /**
   * Recolour one of the four ground materials, keeping its grain.
   *
   * A flat colour would erase the procedural detail that makes the ground read
   * as soil rather than as a painted plane, so each texel is rescaled about the
   * texture's own mean instead: the result averages to exactly the colour asked
   * for, while every bump, speck and streak survives at the same relative
   * strength. Same trick the region uses to keep per-house colour variety under
   * a changed building colour.
   *
   * Cheap enough to call on every slider drag — one 512² pass, no reallocation
   * after the first call for a given kind.
   */
  tintGround(kind: GroundKind, r: number, g: number, b: number) {
    const set = this.library[kind]
    const src = set.albedoData
    const n = set.size * set.size

    let mr = 0
    let mg = 0
    let mb = 0
    for (let i = 0; i < n; i++) {
      mr += src[i * 4]
      mg += src[i * 4 + 1]
      mb += src[i * 4 + 2]
    }
    // Guard a black source: dividing by its mean would be a division by zero.
    mr = Math.max(1, mr / n)
    mg = Math.max(1, mg / n)
    mb = Math.max(1, mb / n)

    let out = this.tinted.get(kind)
    if (!out) {
      out = new Uint8Array(src.length)
      this.tinted.set(kind, out)
    }
    const kr = (r * 255) / mr
    const kg = (g * 255) / mg
    const kb = (b * 255) / mb
    for (let i = 0; i < n; i++) {
      const o = i * 4
      const vr = src[o] * kr
      const vg = src[o + 1] * kg
      const vb = src[o + 2] * kb
      out[o] = vr > 255 ? 255 : vr
      out[o + 1] = vg > 255 ? 255 : vg
      out[o + 2] = vb > 255 ? 255 : vb
      out[o + 3] = src[o + 3]
    }
    set.albedo.update(out)
  }

  /** Put a ground material back to the colour it was generated with. */
  resetGroundTint(kind: GroundKind) {
    const set = this.library[kind]
    set.albedo.update(set.albedoData)
  }

  /** Copy the live dashboard values into the uniforms bound by reference. */
  private applyParams() {
    this.mudParams.z = this.humidity
    this.mudParams.w = this.mudIntensity
    this.envParams.x = this.snow
    this.envParams.y = this.wetGloss
    this.envParams.z = this.debugMode
    this.envParams.w = this.tileScale
  }

  /** Upload only the region of the mud field that changed this frame. */
  syncMudTexture() {
    this.applyParams()
    const dirty = this.field.consumeDirty()
    if (!dirty) return
    const internal = this.mudTexture.getInternalTexture()
    if (!internal) return
    // updateTextureData lives on ThinEngine, which every concrete engine extends;
    // Scene only exposes the AbstractEngine base.
    const engine = this.scene.getEngine() as unknown as ThinEngine
    engine.updateTextureData(
      internal,
      dirty.data,
      dirty.x,
      dirty.y,
      dirty.w,
      dirty.h,
      0,
      0,
      false,
    )
  }

  dispose() {
    this.mesh.dispose()
    this.material.dispose()
    this.mudTexture.dispose()
  }
}
