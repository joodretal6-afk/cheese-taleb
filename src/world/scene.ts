import * as THREE from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import { Rng } from '../engine/math'
import { TERRAIN_SIZE, type Terrain } from './terrain'

/**
 * Scene dressing: sky, lighting and the stones the truck climbs over.
 *
 * Stones come in two flavours, and the split matters for how they feel:
 *   - Small ones are pressed into the height field itself. Because wheels
 *     raycast the height field, a wheel rides up and over them individually —
 *     that is the bump the player feels through the suspension.
 *   - Boulders are real physics colliders, big enough that hitting one should
 *     stop the truck rather than lift it.
 */

export interface SceneSetup {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  sun: THREE.DirectionalLight
  environment: THREE.Texture
}

export function createScene(canvas: HTMLCanvasElement): SceneSetup {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0xa8bdd4)
  // Haze pulls the arena edge into the distance so the 50m boundary is less abrupt.
  scene.fog = new THREE.Fog(0xa8bdd4, 42, 118)

  const camera = new THREE.PerspectiveCamera(58, 1, 0.15, 400)
  camera.position.set(TERRAIN_SIZE / 2, 6, TERRAIN_SIZE / 2 - 12)

  // Sky dome. A gradient is enough to light the scene convincingly and costs
  // nothing to ship; a real HDRI can be swapped in from the editor later.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(200, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColour: { value: new THREE.Color(0x4d7db5) },
        horizonColour: { value: new THREE.Color(0xd8dcd2) },
        groundColour: { value: new THREE.Color(0x8d7f68) },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }`,
      fragmentShader: `
        uniform vec3 topColour;
        uniform vec3 horizonColour;
        uniform vec3 groundColour;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition).y;
          vec3 colour = h > 0.0
            ? mix(horizonColour, topColour, pow(h, 0.55))
            : mix(horizonColour, groundColour, pow(-h, 0.5));
          gl_FragColor = vec4(colour, 1.0);
        }`,
    }),
  )
  sky.name = 'sky'
  scene.add(sky)

  const sun = new THREE.DirectionalLight(0xfff2dd, 2.9)
  sun.position.set(28, 34, 16)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  // Shadow frustum wrapped tightly around the arena keeps texel density high.
  const half = TERRAIN_SIZE * 0.62
  sun.shadow.camera.left = -half
  sun.shadow.camera.right = half
  sun.shadow.camera.top = half
  sun.shadow.camera.bottom = -half
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = 140
  sun.shadow.bias = -0.0012
  sun.shadow.normalBias = 0.035
  sun.target.position.set(TERRAIN_SIZE / 2, 0, TERRAIN_SIZE / 2)
  scene.add(sun)
  scene.add(sun.target)

  // Sky/ground bounce, so shadowed panels are not flat black.
  scene.add(new THREE.HemisphereLight(0xbcd4ef, 0x6a5a44, 1.05))

  const environment = buildEnvironment(renderer)
  scene.environment = environment

  return { renderer, scene, camera, sun, environment }
}

/** Renders the gradient sky once into a cube map for image-based reflections. */
function buildEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer)
  pmrem.compileEquirectangularShader()

  const size = 256
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    // Equirectangular: v maps to elevation, so a vertical gradient is enough.
    const t = 1 - y / (size - 1)
    const top = new THREE.Color(0x4d7db5)
    const horizon = new THREE.Color(0xd8dcd2)
    const ground = new THREE.Color(0x7a6a54)
    const elevation = t * 2 - 1
    const colour =
      elevation > 0
        ? horizon.clone().lerp(top, Math.pow(elevation, 0.55))
        : horizon.clone().lerp(ground, Math.pow(-elevation, 0.5))
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4
      data[o] = Math.round(colour.r * 255)
      data[o + 1] = Math.round(colour.g * 255)
      data[o + 2] = Math.round(colour.b * 255)
      data[o + 3] = 255
    }
  }

  const equirect = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  equirect.mapping = THREE.EquirectangularReflectionMapping
  equirect.colorSpace = THREE.SRGBColorSpace
  equirect.needsUpdate = true

  const target = pmrem.fromEquirectangular(equirect)
  equirect.dispose()
  pmrem.dispose()
  return target.texture
}

export interface ScatterResult {
  group: THREE.Group
  boulderBodies: RAPIER.RigidBody[]
}

/**
 * Scatters stones across the arena, pressing the small ones into the ground so
 * the wheels actually ride them.
 */
export function scatterRocks(
  rapier: typeof RAPIER,
  world: RAPIER.World,
  scene: THREE.Scene,
  terrain: Terrain,
  seed = 90210,
): ScatterResult {
  const rng = new Rng(seed)
  const group = new THREE.Group()
  group.name = 'rocks'
  const boulderBodies: RAPIER.RigidBody[] = []

  const stoneMaterial = new THREE.MeshStandardMaterial({
    color: 0x776d63,
    roughness: 0.88,
    metalness: 0.03,
  })
  stoneMaterial.name = 'stone'

  // --- Small stones: baked into the height field ---------------------------
  const smallCount = 220
  const smallGeometry = new THREE.IcosahedronGeometry(1, 0)
  const smallMesh = new THREE.InstancedMesh(smallGeometry, stoneMaterial, smallCount)
  smallMesh.castShadow = true
  smallMesh.receiveShadow = true
  smallMesh.name = 'small-stones'

  const dummy = new THREE.Object3D()
  for (let i = 0; i < smallCount; i++) {
    const x = rng.range(3, TERRAIN_SIZE - 3)
    const z = rng.range(3, TERRAIN_SIZE - 3)
    const radius = rng.range(0.1, 0.32)

    // Raise the ground under the stone so a wheel climbing it feels the bump
    // rather than clipping through a decorative mesh.
    terrain.raise(x, z, radius * 2.3, radius * 0.78)

    const y = terrain.heightAt(x, z)
    dummy.position.set(x, y - radius * 0.18, z)
    dummy.scale.setScalar(radius)
    dummy.rotation.set(rng.range(0, Math.PI), rng.range(0, Math.PI), rng.range(0, Math.PI))
    dummy.updateMatrix()
    smallMesh.setMatrixAt(i, dummy.matrix)
  }
  smallMesh.instanceMatrix.needsUpdate = true
  group.add(smallMesh)

  // --- Boulders: real colliders --------------------------------------------
  const boulderCount = 14
  for (let i = 0; i < boulderCount; i++) {
    const x = rng.range(6, TERRAIN_SIZE - 6)
    const z = rng.range(6, TERRAIN_SIZE - 6)
    const radius = rng.range(0.55, 1.15)
    const y = terrain.heightAt(x, z)

    const geometry = new THREE.IcosahedronGeometry(radius, 1)
    // Jitter the vertices so no two boulders share a silhouette.
    const position = geometry.attributes.position as THREE.BufferAttribute
    for (let v = 0; v < position.count; v++) {
      const scale = rng.range(0.78, 1.24)
      position.setXYZ(v, position.getX(v) * scale, position.getY(v) * scale * 0.8, position.getZ(v) * scale)
    }
    geometry.computeVertexNormals()

    const mesh = new THREE.Mesh(geometry, stoneMaterial)
    mesh.position.set(x, y + radius * 0.42, z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)

    // Seat it into the ground so it does not look dropped on top.
    terrain.raise(x, z, radius * 1.9, radius * 0.3)

    const bodyDesc = rapier.RigidBodyDesc.fixed().setTranslation(x, y + radius * 0.42, z)
    const body = world.createRigidBody(bodyDesc)
    world.createCollider(rapier.ColliderDesc.ball(radius * 0.86).setFriction(0.9), body)
    boulderBodies.push(body)
  }

  scene.add(group)
  return { group, boulderBodies }
}

/** Invisible walls so the truck cannot drive off the arena. */
export function createBoundaryWalls(rapier: typeof RAPIER, world: RAPIER.World): void {
  const half = TERRAIN_SIZE / 2
  const thickness = 1
  const height = 6
  const centres: { x: number; z: number; hw: number; hz: number }[] = [
    { x: half, z: -thickness, hw: half + thickness, hz: thickness },
    { x: half, z: TERRAIN_SIZE + thickness, hw: half + thickness, hz: thickness },
    { x: -thickness, z: half, hw: thickness, hz: half + thickness },
    { x: TERRAIN_SIZE + thickness, z: half, hw: thickness, hz: half + thickness },
  ]
  for (const c of centres) {
    const body = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(c.x, height / 2, c.z))
    world.createCollider(rapier.ColliderDesc.cuboid(c.hw, height, c.hz), body)
  }
}
