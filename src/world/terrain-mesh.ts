import * as THREE from 'three'
import { HEIGHT_RES, MESH_RES, TERRAIN_SIZE, type Terrain } from './terrain'

/**
 * Draws the mud field.
 *
 * Geometry is deliberately coarser than the height data. Fine relief — tyre
 * ruts, the lip thrown up beside them, stone bumps — is carried by a normal
 * map generated from the full-resolution heights instead of by vertices, which
 * is what keeps the triangle count inside a phone's budget while still letting
 * a rut catch the light.
 *
 * The churn texture drives the wet/dry look: freshly turned mud is darker,
 * smoother and glossier than the packed ground around it.
 */

/** Re-uploading the detail textures is the expensive part, so it is rate limited. */
const TEXTURE_UPDATE_INTERVAL = 0.09

/**
 * How many times the surface material repeats across the arena. At 50m this
 * puts one tile every ~5.5m. Tiling it more finely made the cracks too small
 * to register from the chase camera — the detail was present but invisible,
 * which is the same as absent.
 */
const DETAIL_REPEAT = 9

export class TerrainMesh {
  readonly mesh: THREE.Mesh
  readonly material: THREE.MeshStandardMaterial

  private terrain: Terrain
  private geometry: THREE.PlaneGeometry
  private positions: THREE.BufferAttribute

  private normalData: Uint8Array
  private normalTexture: THREE.DataTexture
  private churnData: Uint8Array
  private churnTexture: THREE.DataTexture

  private pendingTextureRefresh = false
  private timeSinceUpload = 0

  /** Surface material supplied by the artist; null until it finishes loading. */
  private detailNormalTexture: THREE.Texture | null = null
  private detailAoTexture: THREE.Texture | null = null
  private detailUniforms: Record<string, { value: unknown }> | null = null

  constructor(terrain: Terrain) {
    this.terrain = terrain

    this.geometry = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, MESH_RES - 1, MESH_RES - 1)
    // PlaneGeometry is built on XY; lay it flat so +Z runs "into" the scene.
    this.geometry.rotateX(-Math.PI / 2)
    // Shift so the arena spans 0..TERRAIN_SIZE, matching the height array's indexing.
    this.geometry.translate(TERRAIN_SIZE / 2, 0, TERRAIN_SIZE / 2)
    this.positions = this.geometry.attributes.position as THREE.BufferAttribute

    this.normalData = new Uint8Array(HEIGHT_RES * HEIGHT_RES * 4)
    this.normalTexture = new THREE.DataTexture(this.normalData, HEIGHT_RES, HEIGHT_RES, THREE.RGBAFormat)
    this.normalTexture.needsUpdate = true

    this.churnData = new Uint8Array(HEIGHT_RES * HEIGHT_RES * 4)
    this.churnTexture = new THREE.DataTexture(this.churnData, HEIGHT_RES, HEIGHT_RES, THREE.RGBAFormat)
    this.churnTexture.needsUpdate = true

    this.material = this.createMudMaterial()

    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.receiveShadow = true
    this.mesh.castShadow = false
    this.mesh.name = 'terrain'

    this.refreshGeometry()
    this.refreshTextures()
  }

  /**
   * Standard PBR material with the churn map mixed in before lighting.
   * Textures the editor assigns later drop straight into `map`/`normalMap`;
   * the injected code only shifts colour and roughness, so it composes with
   * whatever albedo is bound.
   */
  private createMudMaterial(): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({
      color: 0x6d5b45,
      roughness: 0.94,
      metalness: 0.02,
      normalMap: this.normalTexture,
      normalScale: new THREE.Vector2(1.6, 1.6),
    })

    material.onBeforeCompile = (shader) => {
      shader.uniforms.churnMap = { value: this.churnTexture }
      shader.uniforms.wetColour = { value: new THREE.Color(0x33261a) }
      shader.uniforms.dryColour = { value: new THREE.Color(0x8a7255) }
      shader.uniforms.roadColour = { value: new THREE.Color(0x3a3b3d) }
      shader.uniforms.detailNormalMap = { value: this.detailNormalTexture }
      shader.uniforms.detailAoMap = { value: this.detailAoTexture }
      shader.uniforms.detailRepeat = { value: DETAIL_REPEAT }
      shader.uniforms.detailStrength = { value: 1.9 }
      shader.uniforms.hasDetail = { value: this.detailNormalTexture ? 1 : 0 }
      // Held so a later load can switch the detail on without recompiling.
      this.detailUniforms = shader.uniforms as unknown as Record<string, { value: unknown }>

      // Three.js only emits a UV varying for the texture slots actually bound,
      // and their names shift between versions. Carrying our own removes that
      // coupling entirely.
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec2 vTerrainUv;
           varying vec3 vTerrainTangent;
           varying vec3 vTerrainBitangent;`,
        )
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
           vTerrainUv = uv;
           // Fragment normals live in view space, so the detail perturbation
           // has to arrive there too. The terrain's UVs run along world X and
           // Z, which makes its tangent frame axis-aligned and cheap to carry
           // across: rotate those two axes by the normal matrix here.
           vTerrainTangent = normalize(normalMatrix * vec3(1.0, 0.0, 0.0));
           vTerrainBitangent = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));`,
        )

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform sampler2D churnMap;
           uniform sampler2D detailNormalMap;
           uniform sampler2D detailAoMap;
           uniform float detailRepeat;
           uniform float detailStrength;
           uniform float hasDetail;
           uniform vec3 wetColour;
           uniform vec3 dryColour;
           uniform vec3 roadColour;
           varying vec2 vTerrainUv;
           varying vec3 vTerrainTangent;
           varying vec3 vTerrainBitangent;`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           vec2 detailUv = vTerrainUv * detailRepeat;
           // Ambient occlusion from the surface material darkens the cracks.
           // Applied to albedo rather than through aoMap, which would need a
           // second UV set this mesh does not carry.
           float roadFade = 1.0 - texture2D(churnMap, vTerrainUv).b;
           float detailAo = mix(1.0, texture2D(detailAoMap, detailUv).r, hasDetail * roadFade);
           diffuseColor.rgb *= mix(1.0, detailAo, 0.95);
           vec3 churnSample = texture2D(churnMap, vTerrainUv).rgb;
           float road = churnSample.b;
           // Tarmac neither churns nor holds water.
           float churn = churnSample.r * (1.0 - road);
           float wetness = churnSample.g * (1.0 - road);
           // Undisturbed ground drifts toward the dry tone; churned mud toward
           // the wet one, so ruts darken as they are cut.
           vec3 groundTint = mix(dryColour, wetColour, clamp(wetness * 0.55 + churn * 0.75, 0.0, 1.0));
           diffuseColor.rgb *= groundTint * 1.9;
           // Asphalt over the top, with the surface detail faded out so the
           // road does not inherit the cracked-earth relief.
           diffuseColor.rgb = mix(diffuseColor.rgb, roadColour, road);`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           // Wet mud is glossy; dry packed dirt is not.
           roughnessFactor *= 1.0 - clamp(wetness * 0.45 + churn * 0.35, 0.0, 0.72);`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
           // Two scales of relief have to coexist: the height field's normal
           // map carries the ruts the wheels cut, and this one carries the
           // material's own cracking. Perturbing the already-computed normal
           // keeps both, and avoids reimplementing three.js' tangent frame —
           // whose internals move between versions.
           vec3 detailN = texture2D(detailNormalMap, detailUv).xyz * 2.0 - 1.0;
           vec3 detailPerturb = vTerrainTangent * detailN.x + vTerrainBitangent * detailN.y;
           float roadSmooth = 1.0 - texture2D(churnMap, vTerrainUv).b;
           normal = normalize(normal + detailPerturb * detailStrength * hasDetail * roadSmooth);`,
        )
    }
    // Injected uniforms change the program signature, so give it its own key.
    material.customProgramCacheKey = () => 'mud-terrain'
    return material
  }

  /**
   * Binds the surface material's detail maps.
   *
   * Loading is asynchronous and the terrain must be drawable before it
   * finishes, so the shader is compiled with the detail contribution switched
   * off by `hasDetail` and the flag is raised once the images arrive. Compiling
   * a second program later would stall the frame the truck first touches it.
   */
  async loadSurfaceDetail(normalUrl: string, aoUrl: string): Promise<void> {
    const loader = new THREE.TextureLoader()
    const [normalMap, aoMap] = await Promise.all([loader.loadAsync(normalUrl), loader.loadAsync(aoUrl)])

    for (const texture of [normalMap, aoMap]) {
      texture.wrapS = THREE.RepeatWrapping
      texture.wrapT = THREE.RepeatWrapping
    }
    // AO is a linear mask, not colour; tagging it sRGB would darken it twice.
    aoMap.colorSpace = THREE.NoColorSpace
    normalMap.colorSpace = THREE.NoColorSpace

    this.detailNormalTexture = normalMap
    this.detailAoTexture = aoMap

    const uniforms = this.detailUniforms
    if (uniforms) {
      uniforms.detailNormalMap.value = normalMap
      uniforms.detailAoMap.value = aoMap
      uniforms.hasDetail.value = 1
    }
  }

  update(dt: number): void {
    const rect = this.terrain.consumeDirtyRect()
    if (rect) {
      this.refreshGeometry()
      this.pendingTextureRefresh = true
    }

    this.timeSinceUpload += dt
    if (this.pendingTextureRefresh && this.timeSinceUpload >= TEXTURE_UPDATE_INTERVAL) {
      this.refreshTextures()
      this.pendingTextureRefresh = false
      this.timeSinceUpload = 0
    }
  }

  /** Samples the height field down onto the drawn vertex grid. */
  private refreshGeometry(): void {
    const array = this.positions.array as Float32Array
    const step = TERRAIN_SIZE / (MESH_RES - 1)
    let i = 0
    for (let y = 0; y < MESH_RES; y++) {
      for (let x = 0; x < MESH_RES; x++) {
        array[i * 3 + 1] = this.terrain.heightAt(x * step, y * step)
        i++
      }
    }
    this.positions.needsUpdate = true
    this.geometry.computeVertexNormals()
    this.geometry.computeBoundingSphere()
  }

  /** Bakes heights into a tangent-space normal map and packs churn/wetness alongside. */
  private refreshTextures(): void {
    const heights = this.terrain.heights
    const surface = this.terrain.surface
    const step = this.terrain.heightStep

    for (let y = 0; y < HEIGHT_RES; y++) {
      const yUp = y > 0 ? y - 1 : y
      const yDown = y < HEIGHT_RES - 1 ? y + 1 : y
      for (let x = 0; x < HEIGHT_RES; x++) {
        const index = y * HEIGHT_RES + x
        const xLeft = x > 0 ? x - 1 : x
        const xRight = x < HEIGHT_RES - 1 ? x + 1 : x

        const hL = heights[y * HEIGHT_RES + xLeft]!
        const hR = heights[y * HEIGHT_RES + xRight]!
        const hD = heights[yUp * HEIGHT_RES + x]!
        const hU = heights[yDown * HEIGHT_RES + x]!

        // Central differences over the sample spacing give the surface slope.
        let nx = (hL - hR) / (2 * step)
        let nz = (hD - hU) / (2 * step)
        const ny = 1
        const inv = 1 / Math.hypot(nx, ny, nz)
        nx *= inv
        nz *= inv
        const nyNorm = ny * inv

        const o = index * 4
        // Tangent-space normal maps store +Z as "out of the surface"; here the
        // world up axis is Y, so Y and Z swap on the way into the texture.
        this.normalData[o] = Math.round((nx + 1) * 127.5)
        this.normalData[o + 1] = Math.round((-nz + 1) * 127.5)
        this.normalData[o + 2] = Math.round((nyNorm + 1) * 127.5)
        this.normalData[o + 3] = 255

        this.churnData[o] = Math.round(Math.min(1, surface[index * 2]!) * 255)
        this.churnData[o + 1] = Math.round(Math.min(1, surface[index * 2 + 1]!) * 255)
        // Blue channel is otherwise unused, so the road mask travels for free
        // rather than costing a fourth full-resolution texture.
        this.churnData[o + 2] = Math.round(this.terrain.roadMask[index]! * 255)
        this.churnData[o + 3] = 255
      }
    }

    this.normalTexture.needsUpdate = true
    this.churnTexture.needsUpdate = true
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.normalTexture.dispose()
    this.churnTexture.dispose()
  }
}
