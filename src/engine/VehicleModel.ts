import {
  AbstractMesh,
  Color3,
  ImportMeshAsync,
  Mesh,
  PBRMaterial,
  Quaternion,
  TransformNode,
  Vector3,
  type Scene,
} from '@babylonjs/core'
import '@babylonjs/loaders/glTF'

/**
 * Loads frontier.glb and turns a static KeyShot export into a drivable rig:
 * finds the four wheels, re-parents them onto steer/spin pivots, and normalises
 * the whole thing so +Z is forward and y=0 sits at the tyre contact patch.
 *
 * Nothing here is hard-coded to the export's axis convention — wheels are found
 * by geometry, so the same code survives a re-export or a different truck.
 */

export type WheelId = 'FL' | 'FR' | 'RL' | 'RR'

export interface WheelRig {
  id: WheelId
  /** Steering pivot; also carries the suspension travel offset. */
  steer: TransformNode
  /** Spin pivot, child of `steer`. */
  spin: TransformNode
  /**
   * Wheel centre in the *normalised* chassis frame (+Z forward, +X right,
   * origin at the tyre contact plane). This is what the physics uses.
   */
  restPosition: Vector3
  /** Wheel centre in the visual rig's local frame — what `steer` is placed at. */
  localRest: Vector3
  /**
   * +1, or -1 when the rig was rotated 180° to make +Z forward: the wheel's
   * local X then points the opposite way, so the spin angle must be negated for
   * the tyres to roll in the direction the truck is actually travelling.
   */
  spinSign: number
  radius: number
  width: number
  meshes: AbstractMesh[]
}

export interface LoadedVehicle {
  /** Chassis root. Its origin is the centre of mass reference; y=0 = ground. */
  root: TransformNode
  /** Everything that is not a wheel. */
  bodyMeshes: AbstractMesh[]
  wheels: Record<WheelId, WheelRig>
  /** Half-extents of the body box, metres. */
  halfExtents: Vector3
  wheelbase: number
  track: number
  /** Height of the chassis origin above the ground when at rest. */
  restHeight: number
}

/** Node-name fragments that make up a wheel assembly in the Frontier export. */
const WHEEL_NAME_HINTS = ['rodagti', 'b1', 'Matte_Black__1']

/** Used only to detect the export's unit scale, never to distort proportions. */
const TARGET_LENGTH_M = 5.3

function isWheelMesh(name: string, hints: string[]): boolean {
  return hints.some((h) => name.includes(h))
}

function worldCenter(mesh: AbstractMesh): Vector3 {
  mesh.computeWorldMatrix(true)
  const bb = mesh.getBoundingInfo().boundingBox
  return bb.centerWorld.clone()
}

/**
 * @param wheelHints node-name fragments identifying the wheel assemblies in
 *   THIS export. Every GLB names its parts differently, so the catalogue
 *   carries them per car; the Frontier's are the default.
 * @param targetLengthM nominal bumper-to-bumper length, used only to detect the
 *   export's unit scale.
 */
export async function loadVehicle(
  scene: Scene,
  url: string,
  onProgress?: (fraction: number) => void,
  wheelHints: string[] = WHEEL_NAME_HINTS,
  targetLengthM: number = TARGET_LENGTH_M,
): Promise<LoadedVehicle> {
  const result = await ImportMeshAsync(url, scene, {
    onProgress: (ev) => {
      if (onProgress) onProgress(ev.lengthComputable ? ev.loaded / ev.total : 0)
    },
  })

  const meshes = result.meshes.filter((m): m is Mesh => m instanceof Mesh && !!m.getTotalVertices())
  if (!meshes.length) throw new Error('frontier.glb contained no renderable meshes')

  // The loader's __root__ carries the glTF→Babylon handedness fix. Bake it away
  // by parenting everything to a fresh node, so our maths is in plain Babylon space.
  const staging = new TransformNode('vehicleStaging', scene)
  for (const m of meshes) m.setParent(staging)
  for (const m of result.meshes) {
    if (m.name === '__root__') m.dispose()
  }
  staging.computeWorldMatrix(true)

  // ------------------------------------------------------------ unit scale
  // This export lands 1000× too small (KeyShot wrote a millimetre-scaled root
  // matrix). Rather than hard-code the factor, snap the longest dimension into a
  // plausible vehicle range with a power-of-ten correction — that fixes mm and
  // cm exports alike and leaves a correct metre-scale model untouched.
  {
    const min = new Vector3(Infinity, Infinity, Infinity)
    const max = new Vector3(-Infinity, -Infinity, -Infinity)
    for (const m of meshes) {
      m.computeWorldMatrix(true)
      const bb = m.getBoundingInfo().boundingBox
      min.minimizeInPlace(bb.minimumWorld)
      max.maximizeInPlace(bb.maximumWorld)
    }
    const longest = Math.max(max.x - min.x, max.z - min.z)
    if (longest > 0) {
      const exp = Math.round(Math.log10(targetLengthM / longest))
      if (exp !== 0) {
        const k = Math.pow(10, exp)
        staging.scaling.scaleInPlace(k)
        staging.computeWorldMatrix(true)
        for (const m of meshes) m.computeWorldMatrix(true)
      }
    }
  }

  // ---------------------------------------------------------------- wheels
  const wheelMeshes = meshes.filter((m) => isWheelMesh(m.name, wheelHints))
  if (wheelMeshes.length < 4) throw new Error('could not locate the wheel meshes')

  // Cluster wheel parts by their world centre — four groups fall out naturally.
  interface Cluster { center: Vector3; meshes: AbstractMesh[]; min: Vector3; max: Vector3 }
  const clusters: Cluster[] = []
  for (const m of wheelMeshes) {
    const c = worldCenter(m)
    const bb = m.getBoundingInfo().boundingBox
    let found = clusters.find((cl) => Vector3.Distance(cl.center, c) < 0.6)
    if (!found) {
      found = { center: c.clone(), meshes: [], min: bb.minimumWorld.clone(), max: bb.maximumWorld.clone() }
      clusters.push(found)
    }
    found.meshes.push(m)
    found.min.minimizeInPlace(bb.minimumWorld)
    found.max.maximizeInPlace(bb.maximumWorld)
  }
  if (clusters.length !== 4) {
    const detail = wheelMeshes
      .map((m) => `${m.name} @ ${worldCenter(m).toString()}`)
      .join('\n  ')
    throw new Error(
      `expected 4 wheel clusters, found ${clusters.length}\n` +
        `cluster centres: ${clusters.map((c) => c.center.toString()).join(' | ')}\n` +
        `  ${detail}`,
    )
  }
  for (const cl of clusters) cl.center = cl.min.add(cl.max).scale(0.5)

  // Overall body bounds (used to work out which axle is the front one).
  const bodyMin = new Vector3(Infinity, Infinity, Infinity)
  const bodyMax = new Vector3(-Infinity, -Infinity, -Infinity)
  for (const m of meshes) {
    const bb = m.getBoundingInfo().boundingBox
    bodyMin.minimizeInPlace(bb.minimumWorld)
    bodyMax.maximizeInPlace(bb.maximumWorld)
  }

  // Axle Z positions (two distinct values).
  const zs = [...new Set(clusters.map((c) => Math.round(c.center.z * 100) / 100))].sort((a, b) => a - b)
  const axleA = zs[0]
  const axleB = zs[zs.length - 1]
  // A pickup's front overhang is much shorter than its rear. The axle nearer to
  // its own end of the body is the front one.
  const overhangA = Math.abs(axleA - bodyMin.z)
  const overhangB = Math.abs(bodyMax.z - axleB)
  const frontZ = overhangA < overhangB ? axleA : axleB
  const frontIsNegZ = frontZ < (axleA + axleB) / 2

  /*
   * Build the rig with every transform still identity, re-parent into it (so
   * world-preserving re-parenting is a no-op and nothing shifts), and only then
   * apply the centring offset and the 180° flip. Applying those first and then
   * re-parenting bakes a compensating offset into each mesh, which is what
   * leaves a wheel hanging in mid-air away from the truck.
   */
  const container = new TransformNode('vehicleRoot', scene)
  const pivot = new TransformNode('vehiclePivot', scene)
  pivot.parent = container
  const shift = new TransformNode('vehicleShift', scene)
  shift.parent = pivot

  const wheelRadius = Math.max(
    ...clusters.map((c) => Math.max(c.max.y - c.min.y, c.max.z - c.min.z) * 0.5),
  )
  const wheelWidth = Math.max(...clusters.map((c) => c.max.x - c.min.x))

  // Ground contact is the lowest point of the tyres; shift so it lands on y=0.
  const groundY = Math.min(...clusters.map((c) => c.min.y))
  // Centre the chassis laterally and longitudinally on the wheelbase.
  const midZ = (axleA + axleB) / 2
  const offset = new Vector3(-(bodyMin.x + bodyMax.x) / 2, -groundY, -midZ)

  // ------------------------------------------------------- build wheel rigs
  const wheels = {} as Record<WheelId, WheelRig>
  const flip = frontIsNegZ ? -1 : 1
  for (const cl of clusters) {
    const isFront = Math.abs(cl.center.z - frontZ) < 0.4
    // After the pivot rotation the X axis flips too, so left/right follows suit.
    const isLeft = frontIsNegZ ? cl.center.x > 0 : cl.center.x < 0
    const id: WheelId = `${isFront ? 'F' : 'R'}${isLeft ? 'L' : 'R'}` as WheelId

    const steer = new TransformNode(`wheel_${id}_steer`, scene)
    steer.parent = shift
    const spin = new TransformNode(`wheel_${id}_spin`, scene)
    spin.parent = steer

    // Local frame: shift is still identity here, so this lands the pivot exactly
    // on the wheel centre and re-parenting below changes nothing.
    const localRest = cl.center.clone()
    steer.position = localRest.clone()

    for (const m of cl.meshes) {
      m.setParent(spin)
      m.name = `${m.name}__WHEEL_${id}`
    }

    wheels[id] = {
      id,
      steer,
      spin,
      // Normalised chassis frame: offset applied, then flipped if we rotate.
      restPosition: new Vector3(
        (cl.center.x + offset.x) * flip,
        cl.center.y + offset.y,
        (cl.center.z + offset.z) * flip,
      ),
      localRest,
      spinSign: flip,
      radius: wheelRadius,
      width: wheelWidth,
      meshes: cl.meshes,
    }
  }

  // Everything else becomes the body.
  const bodyMeshes: AbstractMesh[] = []
  for (const m of meshes) {
    if (isWheelMesh(m.name, wheelHints)) continue
    m.setParent(shift)
    bodyMeshes.push(m)
  }
  staging.dispose()

  // Now that everything is in the rig, place it: centre it, put the tyre contact
  // plane on y = 0, and rotate so +Z is forward.
  shift.position = offset
  pivot.rotationQuaternion = frontIsNegZ
    ? Quaternion.FromEulerAngles(0, Math.PI, 0)
    : Quaternion.Identity()

  const halfExtents = new Vector3(
    (bodyMax.x - bodyMin.x) * 0.5,
    (bodyMax.y - bodyMin.y) * 0.5,
    (bodyMax.z - bodyMin.z) * 0.5,
  )

  const wheelbase = Math.abs(axleB - axleA)
  const xs = clusters.map((c) => c.center.x)
  const track = Math.max(...xs) - Math.min(...xs)

  for (const m of [...bodyMeshes, ...Object.values(wheels).flatMap((w) => w.meshes)]) {
    m.receiveShadows = true
    m.isPickable = false
    // KeyShot exports single-sided panels; culling them leaves holes.
    if (m.material) m.material.backFaceCulling = false
  }

  return {
    root: container,
    bodyMeshes,
    wheels,
    halfExtents,
    wheelbase,
    track,
    restHeight: wheelRadius,
  }
}

/**
 * Progressive mud caking.
 *
 * Each mesh gets its own material clone so the coat can be biased by how low the
 * panel sits — sills and wheel arches brown over long before the roof does.
 */
export class MudCoat {
  private entries: {
    mat: PBRMaterial
    baseAlbedo: Color3
    baseRoughness: number
    baseMetallic: number
    /** 0..1, 1 = closest to the ground. */
    lowness: number
  }[] = []

  private _amount = 0

  constructor(vehicle: LoadedVehicle) {
    const all = [...vehicle.bodyMeshes, ...Object.values(vehicle.wheels).flatMap((w) => w.meshes)]
    let minY = Infinity
    let maxY = -Infinity
    for (const m of all) {
      m.computeWorldMatrix(true)
      const c = m.getBoundingInfo().boundingBox.centerWorld.y
      if (c < minY) minY = c
      if (c > maxY) maxY = c
    }
    const span = Math.max(0.001, maxY - minY)

    for (const m of all) {
      const src = m.material
      if (!(src instanceof PBRMaterial)) continue
      const mat = src.clone(`${src.name}__mud_${m.uniqueId}`) as PBRMaterial
      m.material = mat
      const cy = m.getBoundingInfo().boundingBox.centerWorld.y
      this.entries.push({
        mat,
        baseAlbedo: (mat.albedoColor ?? new Color3(1, 1, 1)).clone(),
        baseRoughness: mat.roughness ?? 0.4,
        baseMetallic: mat.metallic ?? 0,
        lowness: 1 - (cy - minY) / span,
      })
    }
  }

  get amount() {
    return this._amount
  }

  /** @param amount 0..1 overall mud load, @param wet 0..1 surface wetness */
  set(amount: number, wet: number) {
    this._amount = amount
    const mudDry = new Color3(0.24, 0.175, 0.11)
    const mudWet = new Color3(0.12, 0.085, 0.055)
    const mud = Color3.Lerp(mudDry, mudWet, wet)

    for (const e of this.entries) {
      // Low panels reach full coverage at ~40% load; the roof needs almost all of it.
      const local = Math.min(1, amount * (0.35 + e.lowness * 1.5))
      e.mat.albedoColor = Color3.Lerp(e.baseAlbedo, mud, local * 0.92)
      // Dried mud is matte; wet mud regains a sheen.
      const target = 0.92 - wet * 0.5
      e.mat.roughness = e.baseRoughness + (target - e.baseRoughness) * local
      e.mat.metallic = e.baseMetallic * (1 - local * 0.9)
    }
  }
}
