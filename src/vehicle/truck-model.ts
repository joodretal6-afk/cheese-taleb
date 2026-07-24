import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { PICKUP_SPEC } from './vehicle'
import type { TruckBuild } from './truck-mesh'

/**
 * Loads an authored vehicle model and adapts it to the physics rig.
 *
 * A downloaded model knows nothing about our simulation: it arrives at an
 * arbitrary scale, facing an arbitrary direction, with its wheels welded into
 * the body transform. Rather than hand-editing the asset — which would have to
 * be redone every time it is replaced — everything is derived at load time
 * from the geometry itself, so swapping in a different truck is a one-line
 * change.
 */

export interface ModelBindingOptions {
  /** Node names that identify wheels, matched case-insensitively as substrings. */
  wheelNamePatterns: string[]
  /**
   * Rotation about Y applied before measuring, in radians. Models are authored
   * facing whichever way the artist preferred; the game needs +Z forward.
   */
  headingOffset: number
  /** Overrides the automatic scale when a model's proportions are unusual. */
  scaleOverride?: number
}

export const DEFAULT_BINDING: ModelBindingOptions = {
  wheelNamePatterns: ['roda', 'wheel', 'tyre', 'tire', 'rim'],
  headingOffset: 0,
}

export interface LoadedTruck extends TruckBuild {
  /** Every distinct material in the model, addressable by name for the editor. */
  materialsByName: Map<string, THREE.MeshStandardMaterial>
  triangleCount: number
  /** Dimensions after fitting, in metres. */
  size: THREE.Vector3
}

export async function loadTruckModel(
  url: string,
  options: Partial<ModelBindingOptions> = {},
): Promise<LoadedTruck> {
  const binding = { ...DEFAULT_BINDING, ...options }

  const loader = new GLTFLoader()
  const draco = new DRACOLoader()
  // Served from the same origin so the decoder works offline in the APK.
  draco.setDecoderPath('./draco/')
  loader.setDRACOLoader(draco)

  const gltf = await loader.loadAsync(url)
  const source = gltf.scene
  source.updateWorldMatrix(true, true)

  if (binding.headingOffset !== 0) {
    source.rotation.y = binding.headingOffset
    source.updateWorldMatrix(true, true)
  }

  // --- Identify wheels before measuring the body -----------------------------
  // Wheels must be excluded from the body bounds, otherwise the chassis box is
  // inflated by them and the scale comes out wrong.
  const wheelRoots = findWheelRoots(source, binding.wheelNamePatterns)

  const bodyBox = boundsExcluding(source, wheelRoots)
  const bodySize = bodyBox.getSize(new THREE.Vector3())

  // --- Fit to the physics rig ------------------------------------------------
  // Length is the most reliable axis to match on: width varies with mirrors and
  // height with roof racks, but a pickup's length is its length.
  const targetLength = PICKUP_SPEC.bodyHalfLength * 2
  const scale = binding.scaleOverride ?? targetLength / Math.max(bodySize.z, 1e-6)

  const group = new THREE.Group()
  group.name = 'truck'
  const inner = new THREE.Group()
  inner.name = 'truck-model'
  inner.scale.setScalar(scale)
  group.add(inner)

  // --- Detach wheels so they can steer and spin independently ----------------
  const wheelPivots: THREE.Object3D[] = []
  const detached: { object: THREE.Object3D; centre: THREE.Vector3 }[] = []
  for (const root of wheelRoots) {
    const centre = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3())
    detached.push({ object: root, centre })
  }

  // Match each physics wheel to the nearest modelled wheel by position, so the
  // pairing survives whatever order the file happens to list them in.
  const claimed = new Set<THREE.Object3D>()
  for (const config of PICKUP_SPEC.wheels) {
    // Physics wheel position expressed in the model's own (pre-scale) space.
    const wantX = config.x / scale
    const wantZ = config.z / scale
    let best: { object: THREE.Object3D; centre: THREE.Vector3 } | null = null
    let bestDistance = Infinity
    for (const candidate of detached) {
      if (claimed.has(candidate.object)) continue
      const d = Math.hypot(candidate.centre.x - wantX, candidate.centre.z - wantZ)
      if (d < bestDistance) {
        bestDistance = d
        best = candidate
      }
    }

    const pivot = new THREE.Object3D()
    pivot.position.set(config.x, config.y, config.z)
    group.add(pivot)
    wheelPivots.push(pivot)

    if (!best) continue
    claimed.add(best.object)

    // Re-parent under a pivot at the wheel's own centre, so rotation happens
    // about the axle rather than about the model origin.
    const spinner = new THREE.Object3D()
    spinner.scale.setScalar(scale)
    best.object.parent?.remove(best.object)
    best.object.position.sub(best.centre)
    spinner.add(best.object)
    pivot.add(spinner)
  }

  // --- Seat the body ---------------------------------------------------------
  // Re-measure after the wheels were removed, then centre the body laterally
  // and align it so the chassis origin sits where the physics expects it.
  const seatedBox = new THREE.Box3().setFromObject(inner.add(source) && inner)
  const seatedCentre = seatedBox.getCenter(new THREE.Vector3())
  source.position.x -= seatedCentre.x / scale
  source.position.z -= seatedCentre.z / scale
  // Drop the body so its underside clears the wheel centres by the tyre radius.
  source.position.y -= (seatedBox.min.y + PICKUP_SPEC.wheels[0]!.radius * 0.55) / scale

  let triangleCount = 0
  const materialsByName = new Map<string, THREE.MeshStandardMaterial>()
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    object.castShadow = true
    object.receiveShadow = true
    const index = object.geometry.index
    triangleCount += index ? index.count / 3 : object.geometry.attributes.position.count / 3
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material instanceof THREE.MeshStandardMaterial) {
        materialsByName.set(material.name || `material_${materialsByName.size}`, material)
      }
    }
  })

  draco.dispose()

  return {
    group,
    wheelPivots,
    // The parametric part map does not apply to an imported model; the editor
    // drives `materialsByName` instead.
    materials: {} as TruckBuild['materials'],
    materialsByName,
    triangleCount: Math.round(triangleCount),
    size: bodySize.multiplyScalar(scale),
  }
}

/**
 * Finds the outermost node of each wheel. Matching the outermost node matters:
 * a wheel is usually several meshes (tyre, rim, brake) and they must rotate
 * together.
 */
function findWheelRoots(root: THREE.Object3D, patterns: string[]): THREE.Object3D[] {
  const matches: THREE.Object3D[] = []
  const isWheelName = (name: string): boolean => {
    const lower = name.toLowerCase()
    return patterns.some((pattern) => lower.includes(pattern))
  }

  root.traverse((object) => {
    if (!isWheelName(object.name)) return
    // Skip anything already covered by an ancestor we matched.
    for (let parent = object.parent; parent; parent = parent.parent) {
      if (isWheelName(parent.name)) return
    }
    matches.push(object)
  })
  return matches
}

function boundsExcluding(root: THREE.Object3D, excluded: THREE.Object3D[]): THREE.Box3 {
  const excludedSet = new Set(excluded)
  const box = new THREE.Box3()
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) {
      if (excludedSet.has(parent)) return
    }
    box.expandByObject(object)
  })
  return box
}
