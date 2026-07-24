import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { PICKUP_SPEC } from './vehicle'

/**
 * Parametric pickup.
 *
 * Every panel is a separately named mesh carrying its own material, so the
 * admin panel can bind a texture to one part at a time — "the driver's door",
 * "the windscreen", "the grille" — instead of to the truck as a whole. Edges
 * are rounded rather than hard-cut: a bevel is what stops a box reading as a
 * box once a specular highlight runs along it.
 */

/** Stable identifiers the editor binds textures to. Order drives the UI list. */
export const TRUCK_PART_IDS = [
  'body',
  'hood',
  'roof',
  'cabin',
  'bed',
  'bedFloor',
  'doorFrontLeft',
  'doorFrontRight',
  'doorRearLeft',
  'doorRearRight',
  'windscreen',
  'rearWindow',
  'windowLeft',
  'windowRight',
  'grille',
  'bumperFront',
  'bumperRear',
  'headlightLeft',
  'headlightRight',
  'taillightLeft',
  'taillightRight',
  'mirrorLeft',
  'mirrorRight',
  'sideStep',
  'tyre',
  'rim',
] as const

export type TruckPartId = (typeof TRUCK_PART_IDS)[number]

export const TRUCK_PART_LABELS: Record<TruckPartId, string> = {
  body: 'الهيكل',
  hood: 'الكبّوت',
  roof: 'السقف',
  cabin: 'الكابينة',
  bed: 'الصندوق الخلفي',
  bedFloor: 'أرضية الصندوق',
  doorFrontLeft: 'الباب الأمامي الأيسر',
  doorFrontRight: 'الباب الأمامي الأيمن',
  doorRearLeft: 'الباب الخلفي الأيسر',
  doorRearRight: 'الباب الخلفي الأيمن',
  windscreen: 'الزجاج الأمامي',
  rearWindow: 'الزجاج الخلفي',
  windowLeft: 'زجاج جانبي أيسر',
  windowRight: 'زجاج جانبي أيمن',
  grille: 'الشبك الأمامي',
  bumperFront: 'الصادم الأمامي',
  bumperRear: 'الصادم الخلفي',
  headlightLeft: 'كشاف أيسر',
  headlightRight: 'كشاف أيمن',
  taillightLeft: 'ستوب أيسر',
  taillightRight: 'ستوب أيمن',
  mirrorLeft: 'مرآة يسار',
  mirrorRight: 'مرآة يمين',
  sideStep: 'الرِكاب الجانبي',
  tyre: 'الكفر',
  rim: 'الجنط',
}

export interface TruckBuild {
  /** Chassis group — position and orientation are driven by physics. */
  group: THREE.Group
  /** Wheel pivots; the vehicle drives their steer and spin each frame. */
  wheelPivots: THREE.Object3D[]
  /** One material per part id, addressable by the editor. */
  materials: Record<TruckPartId, THREE.MeshStandardMaterial>
}

interface Palette {
  paint: number
  trim: number
  glass: number
  chrome: number
  rubber: number
  rim: number
}

const DEFAULT_PALETTE: Palette = {
  paint: 0xf2f4f7,
  trim: 0x2b3038,
  glass: 0x18242e,
  chrome: 0xb9c0c8,
  rubber: 0x14161a,
  rim: 0xc7ccd2,
}

export function buildTruck(palette: Partial<Palette> = {}): TruckBuild {
  const colours = { ...DEFAULT_PALETTE, ...palette }
  const group = new THREE.Group()
  group.name = 'truck'

  const materials = createMaterials(colours)
  const add = (id: TruckPartId, geometry: THREE.BufferGeometry, x: number, y: number, z: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, materials[id])
    mesh.position.set(x, y, z)
    mesh.name = id
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    return mesh
  }

  // --- Main volumes -------------------------------------------------------
  // Lower body: the full-length tub the cabin and bed sit on.
  add('body', new RoundedBoxGeometry(1.72, 0.66, 5.0, 4, 0.09), 0, -0.2, 0)

  // Bonnet slopes down toward the grille; a flat bonnet is the single biggest
  // giveaway of a box-modelled vehicle.
  const hood = add('hood', new RoundedBoxGeometry(1.78, 0.3, 1.42, 3, 0.07), 0, 0.26, 1.66)
  hood.rotation.x = -0.055

  // Cabin, narrower than the body so the shoulder line reads.
  add('cabin', new RoundedBoxGeometry(1.7, 0.78, 2.06, 4, 0.1), 0, 0.55, 0.28)
  add('roof', new RoundedBoxGeometry(1.62, 0.1, 1.9, 3, 0.05), 0, 0.96, 0.3)

  // --- Bed ----------------------------------------------------------------
  const bedZ = -1.74
  add('bedFloor', new THREE.BoxGeometry(1.72, 0.07, 1.92), 0, 0.2, bedZ)
  add('bed', new RoundedBoxGeometry(0.13, 0.46, 1.94, 2, 0.04), -0.86, 0.42, bedZ)
  const bedRight = add('bed', new RoundedBoxGeometry(0.13, 0.46, 1.94, 2, 0.04), 0.86, 0.42, bedZ)
  bedRight.name = 'bedRight'
  const tailgate = add('bed', new RoundedBoxGeometry(1.78, 0.46, 0.11, 2, 0.04), 0, 0.42, bedZ - 1.0)
  tailgate.name = 'tailgate'

  // --- Doors --------------------------------------------------------------
  // Slightly proud of the cabin so panel gaps catch light.
  const doorGeometry = new RoundedBoxGeometry(0.07, 0.62, 0.92, 2, 0.03)
  add('doorFrontLeft', doorGeometry, -0.87, 0.44, 0.72)
  add('doorFrontRight', doorGeometry, 0.87, 0.44, 0.72)
  add('doorRearLeft', doorGeometry, -0.87, 0.44, -0.22)
  add('doorRearRight', doorGeometry, 0.87, 0.44, -0.22)

  // --- Glass --------------------------------------------------------------
  const windscreen = add('windscreen', new THREE.BoxGeometry(1.56, 0.62, 0.05), 0, 0.72, 1.24)
  windscreen.rotation.x = -0.42
  const rearWindow = add('rearWindow', new THREE.BoxGeometry(1.5, 0.5, 0.05), 0, 0.74, -0.68)
  rearWindow.rotation.x = 0.2
  add('windowLeft', new THREE.BoxGeometry(0.05, 0.44, 1.76), -0.845, 0.74, 0.3)
  add('windowRight', new THREE.BoxGeometry(0.05, 0.44, 1.76), 0.845, 0.74, 0.3)

  // --- Front end ----------------------------------------------------------
  add('grille', new RoundedBoxGeometry(1.5, 0.34, 0.1, 2, 0.03), 0, 0.16, 2.44)
  add('bumperFront', new RoundedBoxGeometry(1.9, 0.28, 0.24, 3, 0.07), 0, -0.2, 2.5)
  add('headlightLeft', new RoundedBoxGeometry(0.46, 0.2, 0.09, 2, 0.04), -0.62, 0.2, 2.46)
  add('headlightRight', new RoundedBoxGeometry(0.46, 0.2, 0.09, 2, 0.04), 0.62, 0.2, 2.46)

  // --- Rear end -----------------------------------------------------------
  add('bumperRear', new RoundedBoxGeometry(1.9, 0.26, 0.22, 3, 0.06), 0, -0.22, -2.52)
  add('taillightLeft', new RoundedBoxGeometry(0.22, 0.4, 0.08, 2, 0.03), -0.78, 0.34, -2.72)
  add('taillightRight', new RoundedBoxGeometry(0.22, 0.4, 0.08, 2, 0.03), 0.78, 0.34, -2.72)

  // --- Details ------------------------------------------------------------
  add('sideStep', new RoundedBoxGeometry(0.15, 0.08, 1.86, 2, 0.03), -0.87, -0.5, 0.35)
  const stepRight = add('sideStep', new RoundedBoxGeometry(0.15, 0.08, 1.86, 2, 0.03), 0.87, -0.5, 0.35)
  stepRight.name = 'sideStepRight'

  const mirrorArm = new RoundedBoxGeometry(0.2, 0.13, 0.07, 2, 0.03)
  add('mirrorLeft', mirrorArm, -1.0, 0.68, 1.12)
  add('mirrorRight', mirrorArm, 1.0, 0.68, 1.12)

  // --- Wheels -------------------------------------------------------------
  // Mount points come from the physics spec rather than being repeated here:
  // if the two ever drifted apart the wheels would render off their contact
  // patches, which is exactly the kind of bug that is invisible in code review.
  const wheelPivots: THREE.Object3D[] = []
  for (const config of PICKUP_SPEC.wheels) {
    const pivot = new THREE.Object3D()
    pivot.position.set(config.x, config.y, config.z)
    pivot.add(buildWheel(materials, config, config.x < 0))
    group.add(pivot)
    wheelPivots.push(pivot)
  }

  return { group, wheelPivots, materials }
}

/** Tyre plus rim, oriented so the axle runs along X. */
function buildWheel(
  materials: Record<TruckPartId, THREE.MeshStandardMaterial>,
  config: { radius: number; width: number },
  isLeft: boolean,
): THREE.Group {
  const wheel = new THREE.Group()
  const { radius, width } = config

  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 26, 1), materials.tyre)
  tyre.rotation.z = Math.PI / 2
  tyre.castShadow = true
  tyre.name = 'tyre'
  wheel.add(tyre)

  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.63, radius * 0.63, width * 1.04, 20, 1),
    materials.rim,
  )
  rim.rotation.z = Math.PI / 2
  rim.name = 'rim'
  wheel.add(rim)

  // Spokes read as depth at a distance far more cheaply than a modelled face.
  for (let i = 0; i < 6; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(width * 1.06, 0.055, radius * 1.06), materials.rim)
    spoke.rotation.x = (i / 6) * Math.PI * 2
    spoke.name = 'rim'
    wheel.add(spoke)
  }

  // Nudge the outer face outward on the correct side.
  wheel.position.x = isLeft ? -0.005 : 0.005
  return wheel
}

function createMaterials(colours: Palette): Record<TruckPartId, THREE.MeshStandardMaterial> {
  const paint = () =>
    new THREE.MeshStandardMaterial({
      color: colours.paint,
      metalness: 0.55,
      roughness: 0.32,
      envMapIntensity: 1.15,
    })

  const glass = () =>
    new THREE.MeshStandardMaterial({
      color: colours.glass,
      metalness: 0.1,
      roughness: 0.06,
      transparent: true,
      opacity: 0.62,
      envMapIntensity: 1.6,
    })

  const trim = (roughness = 0.72) =>
    new THREE.MeshStandardMaterial({ color: colours.trim, metalness: 0.24, roughness })

  const materials = {
    body: paint(),
    hood: paint(),
    roof: paint(),
    cabin: paint(),
    bed: paint(),
    bedFloor: new THREE.MeshStandardMaterial({ color: 0x40464e, metalness: 0.5, roughness: 0.72 }),
    doorFrontLeft: paint(),
    doorFrontRight: paint(),
    doorRearLeft: paint(),
    doorRearRight: paint(),
    windscreen: glass(),
    rearWindow: glass(),
    windowLeft: glass(),
    windowRight: glass(),
    grille: new THREE.MeshStandardMaterial({ color: colours.trim, metalness: 0.82, roughness: 0.34 }),
    bumperFront: trim(0.6),
    bumperRear: trim(0.6),
    headlightLeft: new THREE.MeshStandardMaterial({
      color: 0xdfe9f2,
      metalness: 0.1,
      roughness: 0.08,
      emissive: 0x223344,
      emissiveIntensity: 0.35,
    }),
    headlightRight: new THREE.MeshStandardMaterial({
      color: 0xdfe9f2,
      metalness: 0.1,
      roughness: 0.08,
      emissive: 0x223344,
      emissiveIntensity: 0.35,
    }),
    taillightLeft: new THREE.MeshStandardMaterial({
      color: 0x8e1119,
      metalness: 0.2,
      roughness: 0.2,
      emissive: 0x5a0a0e,
      emissiveIntensity: 0.5,
    }),
    taillightRight: new THREE.MeshStandardMaterial({
      color: 0x8e1119,
      metalness: 0.2,
      roughness: 0.2,
      emissive: 0x5a0a0e,
      emissiveIntensity: 0.5,
    }),
    mirrorLeft: trim(0.5),
    mirrorRight: trim(0.5),
    sideStep: trim(0.55),
    tyre: new THREE.MeshStandardMaterial({ color: colours.rubber, metalness: 0.02, roughness: 0.95 }),
    rim: new THREE.MeshStandardMaterial({ color: colours.rim, metalness: 0.88, roughness: 0.26 }),
  } satisfies Record<TruckPartId, THREE.MeshStandardMaterial>

  for (const id of TRUCK_PART_IDS) materials[id].name = id
  return materials
}
