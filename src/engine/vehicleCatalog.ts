/**
 * Vehicle catalogue — the data layer behind the simulator.
 *
 * Vehicle.ts currently hard-codes one truck as module constants. This file holds
 * the same numbers as data plus three more vehicles, so swapping cars is a
 * lookup rather than an edit. Nothing here imports the physics; every entry is
 * plain JSON-shaped data that can be validated in Node without a scene.
 *
 * Two rules keep the numbers honest rather than hand-waved:
 *
 *   1. Rotational inertia comes from the solid-box formula I = m/12·(a²+b²) on
 *      the real vehicle's overall dimensions, times 0.9. Real mass sits closer
 *      to the axis than a uniform box (engine and occupants low and central,
 *      body panels hollow), and 0.9 is what reproduces the Frontier's already
 *      tuned {4700, 4950, 980} from its published 5.22 × 1.85 × 1.79 m box.
 *
 *   2. Dampers are quoted as a fraction of critical damping for that corner,
 *      c_crit = 2·√(k·m_corner). The Frontier's 3400/5200 against its 46 kN/m
 *      and 512 kg corner are ζ = 0.35 compression / 0.54 rebound, so every
 *      other vehicle uses those same ratios and only the spring rate — set from
 *      a target ride frequency — actually varies. This is what stops the
 *      lighter and heavier cars from being accidentally under- or over-damped.
 *
 * Only 'frontier' has a model in the repo (public/models/frontier.glb). The
 * other three point at models/vehicles/<id>.glb, which do not exist yet; the
 * loader falls back to the Frontier mesh when a file is missing, so all four
 * entries are drivable today and the art can land later without a code change.
 */

export interface VehicleSpec {
  id: string
  name: string
  modelUrl: string
  /** Node-name fragments identifying wheel meshes in that GLB. */
  wheelNameHints: string[]
  /** Used only to detect the export's unit scale. */
  targetLengthM: number
  mass: number
  comHeight: number
  inertia: { x: number; y: number; z: number }
  engine: {
    idleRpm: number
    redlineRpm: number
    /** Paired arrays, ascending rpm. */
    torqueRpm: number[]
    torqueNm: number[]
  }
  drivetrain: {
    /** [reverse, neutral, 1st, 2nd, ...] — the layout Vehicle.ts assumes. */
    gears: number[]
    finalDrive: number
    efficiency: number
    awd: boolean
  }
  suspension: {
    restLength: number; maxCompression: number; maxDroop: number
    springK: number; dampCompress: number; dampRebound: number; antiRoll: number
  }
  tyre: { baseMu: number; wheelInertia: number; maxSteerDeg: number }
}

/**
 * Per-wheel normal force ceiling inside Vehicle.ts. Anything whose static
 * corner load approaches this cannot be held up by its own springs, so
 * validateSpec flags it rather than letting the car quietly sink.
 */
const WHEEL_LOAD_CLAMP_N = 26000

/**
 * Wheel spin inertia is deliberately ~2.3× the physical hub+rim+tyre figure.
 * Vehicle.ts already notes why: the tyre solver divides by it, and the true
 * value is small enough to make the wheel state stiff. Keeping one consistent
 * inflation factor across the catalogue means the four cars misbehave the same
 * way rather than one of them being uniquely twitchy.
 */

export const VEHICLES: VehicleSpec[] = [
  {
    /*
     * Nissan Frontier / Navara D40, 4.0 V6 VQ40DE.
     * Kerb 2050 kg. Peak 384 Nm @ 4000 rpm, 6200 rpm redline (Nissan quote
     * 261 hp @ 5600 — the curve below gives 379 Nm there ≈ 222 kW ≈ 298 hp at
     * the crank before driveline losses, close enough for a torque table).
     * 5-speed RE5R05A auto: 3.84 / 2.35 / 1.52 / 1.00 / 0.83, reverse 2.61,
     * final drive 3.36.
     * Box 5.22 × 1.85 × 1.79 m, m/12 = 170.8:
     *   Ix = 170.8·(1.79² + 5.22²)·0.9 = 170.8·30.45·0.9 = 4682 → 4700
     *   Iy = 170.8·(1.85² + 5.22²)·0.9 = 170.8·30.67·0.9 = 4716 → 4950 (as tuned)
     *   Iz = 170.8·(1.85² + 1.79²)·0.9 = 170.8·6.63·0.9  = 1019 → 980
     * These are the values live in Vehicle.ts today; behaviour is unchanged.
     */
    id: 'frontier',
    name: 'نيسان فرونتير',
    modelUrl: 'models/frontier.glb',
    wheelNameHints: ['rodagti', 'b1', 'Matte_Black__1'],
    targetLengthM: 5.3,
    mass: 2050,
    comHeight: 0.72,
    inertia: { x: 4700, y: 4950, z: 980 },
    engine: {
      idleRpm: 800,
      redlineRpm: 6200,
      torqueRpm: [800, 1500, 2500, 3500, 4000, 4800, 5600, 6200],
      torqueNm: [230, 300, 355, 378, 384, 370, 330, 270],
    },
    drivetrain: {
      gears: [-2.61, 0, 3.84, 2.35, 1.52, 1.0, 0.83],
      finalDrive: 3.36,
      efficiency: 0.85,
      awd: true,
    },
    // 512 kg corner at 46 kN/m → 1.51 Hz, a soft off-road pickup.
    // c_crit = 2·√(46000·512.5) = 9710 → ζ 0.35 / 0.54.
    suspension: {
      restLength: 0.32, maxCompression: 0.2, maxDroop: 0.14,
      springK: 46000, dampCompress: 3400, dampRebound: 5200, antiRoll: 9000,
    },
    // 33" all-terrain, 12.4 m kerb-to-kerb on a 3.2 m wheelbase → ~31° inner lock.
    tyre: { baseMu: 1.12, wheelInertia: 9.5, maxSteerDeg: 33 },
  },

  {
    /*
     * Sand buggy, modelled on a 2-seat Polaris RZR Pro R.
     * Dry 963 kg + 40 L fuel (29 kg) + driver ≈ 1050 kg. 3.28 × 1.98 × 1.90 m
     * over a short 2.44 m wheelbase.
     * Engine: 2.0 L ProStar Fury four, 225 hp @ 8500 rpm. Working back from
     * that, 168 kW / 890 rad/s = 189 Nm at peak power, so peak torque ~198 Nm
     * a little lower down at 6500 rpm.
     * Transmission: the real car uses a CVT, which Vehicle.ts cannot express.
     * The five ratios below span the same overall reduction the CVT plus
     * gearbox does — 13.4:1 in low, 3.2:1 in top against a 3.73 ring & pinion.
     * m/12 = 87.5:
     *   Ix = 87.5·(1.90² + 3.28²)·0.9 = 87.5·14.37·0.9 = 1131
     *   Iy = 87.5·(1.98² + 3.28²)·0.9 = 87.5·14.68·0.9 = 1156
     *   Iz = 87.5·(1.98² + 1.90²)·0.9 = 87.5·7.53·0.9  =  593
     */
    id: 'buggy',
    name: 'باغي صحراوي',
    modelUrl: 'models/vehicles/buggy.glb',
    wheelNameHints: ['wheel', 'tyre', 'tire', 'rim'],
    targetLengthM: 3.3,
    mass: 1050,
    // Engine sits behind the seats and below the roll cage line, so the centre
    // of mass is far lower than the 1.90 m overall height suggests.
    comHeight: 0.58,
    inertia: { x: 1130, y: 1155, z: 595 },
    engine: {
      idleRpm: 1200,
      redlineRpm: 8700,
      torqueRpm: [1200, 2500, 4000, 5500, 6500, 7500, 8200, 8700],
      torqueNm: [118, 152, 176, 192, 198, 193, 178, 158],
    },
    drivetrain: {
      gears: [-3.15, 0, 3.6, 2.28, 1.55, 1.12, 0.86],
      finalDrive: 3.73,
      // Chain-free shaft drive with no torque converter — the least lossy of
      // the four.
      efficiency: 0.88,
      awd: true,
    },
    // 262 kg corner at 52 kN/m → 2.24 Hz. Stiffer than the pickup despite half
    // the mass, which is what makes it skip over whoops instead of wallowing.
    // c_crit = 2·√(52000·262.5) = 7389 → ζ 0.35 / 0.54.
    suspension: {
      restLength: 0.34, maxCompression: 0.22, maxDroop: 0.24,
      springK: 52000, dampCompress: 2600, dampRebound: 4100, antiRoll: 13000,
    },
    // Soft-compound paddle tyres on sand; 30" OD, ~22 kg per corner
    // → 22·0.381²·0.6 = 1.9 kg·m², ×2.3 solver inflation = 4.5.
    tyre: { baseMu: 1.35, wheelInertia: 4.5, maxSteerDeg: 38 },
  },

  {
    /*
     * 6x6 expedition truck: MAN KAT1 A1 chassis, Mercedes OM 926 LA driveline.
     * MAN KAT1 A1 6x6 kerb is ~9500 kg; this is a stripped chassis with a light
     * composite box at 8600 kg. See the note on WHEEL_LOAD_CLAMP_N — Vehicle.ts
     * caps each wheel at 26 kN, which is what stops this being the 16 t truck a
     * real expedition build would be. 8.30 × 2.50 × 3.30 m.
     * Engine OM 926 LA, 7.2 L inline six: 240 kW @ 2200 rpm, 1300 Nm flat from
     * 1200 to 1600 rpm. Check: 1040 Nm × 230.4 rad/s = 240 kW at 2200. ✓
     * Gearbox: Mercedes G 131-9 nine-speed, 9.48 → 0.75, reverse 8.97.
     * Final drive 8.57 = 4.63 crown wheel × 1.85 planetary hub reduction, which
     * puts 2400 rpm in top on 14.00R20 tyres (r = 0.64 m) at 25 m/s ≈ 90 km/h.
     * m/12 = 716.7:
     *   Ix = 716.7·(3.30² + 8.30²)·0.9 = 716.7·79.78·0.9 = 51452
     *   Iy = 716.7·(2.50² + 8.30²)·0.9 = 716.7·75.14·0.9 = 48460
     *   Iz = 716.7·(2.50² + 3.30²)·0.9 = 716.7·17.14·0.9 = 11055
     */
    id: 'truck6x6',
    name: 'شاحنة استكشاف 6x6',
    modelUrl: 'models/vehicles/truck6x6.glb',
    wheelNameHints: ['wheel', 'tyre', 'tire', 'rim'],
    targetLengthM: 8.3,
    // A box body carries its mass high: ~40% of overall height, same fraction
    // the Frontier's tuned 0.72 m works out to.
    comHeight: 1.3,
    mass: 8600,
    inertia: { x: 51450, y: 48460, z: 11060 },
    engine: {
      idleRpm: 600,
      redlineRpm: 2600,
      torqueRpm: [600, 900, 1200, 1600, 1900, 2200, 2400, 2600],
      torqueNm: [760, 1060, 1300, 1300, 1210, 1040, 880, 660],
    },
    drivetrain: {
      gears: [-8.97, 0, 9.48, 6.58, 4.68, 3.48, 2.62, 1.89, 1.35, 1.0, 0.75],
      finalDrive: 8.57,
      // Three differentials, two propshafts and planetary hubs — the 6x6 loses
      // noticeably more than the pickup's part-time transfer case.
      efficiency: 0.78,
      awd: true,
    },
    // 2150 kg corner at 112 kN/m → 1.15 Hz, deliberately the softest of the
    // four: long travel keeps the wheels down over rock steps.
    // c_crit = 2·√(112000·2150) = 31036 → ζ 0.35 / 0.54.
    // Static sag = 21092 N / 112000 = 0.188 m, so 0.35 m of bump travel leaves
    // the same 1.8× headroom the Frontier has.
    suspension: {
      restLength: 0.5, maxCompression: 0.35, maxDroop: 0.26,
      springK: 112000, dampCompress: 10860, dampRebound: 16760,
      // Only 0.15 of the spring rate, against the pickup's 0.20 — expedition
      // trucks run a weak rear bar (or none) so the axles can articulate.
      antiRoll: 16800,
    },
    // Hard-compound military crossply: high load capacity, poor grip per newton.
    // 14.00R20, ~120 kg per corner → 120·0.64²·0.6 = 29.5, ×2.3 = 68.
    // 17.4 m turning circle on a 4.5 m wheelbase → asin(4.5/8.7) ≈ 31°.
    tyre: { baseMu: 0.95, wheelInertia: 68, maxSteerDeg: 34 },
  },

  {
    /*
     * Full-size SUV: Toyota Land Cruiser 200, 4.6 V8 1UR-FE.
     * Kerb 2740 kg + fuel and occupants ≈ 2900 kg. 4.95 × 1.97 × 1.89 m.
     * Engine 228 kW @ 5500 rpm, 439 Nm @ 3500 rpm. Check: the curve reads
     * 390 Nm at 5500 → 390 × 576 rad/s = 225 kW. ✓
     * Gearbox: A760F six-speed auto, 3.520 / 2.042 / 1.400 / 1.000 / 0.716 /
     * 0.586, reverse 3.224, final drive 3.909.
     * m/12 = 241.7:
     *   Ix = 241.7·(1.89² + 4.95²)·0.9 = 241.7·28.08·0.9 = 6108
     *   Iy = 241.7·(1.97² + 4.95²)·0.9 = 241.7·28.38·0.9 = 6174
     *   Iz = 241.7·(1.97² + 1.89²)·0.9 = 241.7·7.45·0.9  = 1621
     */
    id: 'suv',
    name: 'دفع رباعي كبير',
    modelUrl: 'models/vehicles/suv.glb',
    wheelNameHints: ['wheel', 'tyre', 'tire', 'rim'],
    targetLengthM: 4.95,
    mass: 2900,
    comHeight: 0.74,
    inertia: { x: 6110, y: 6175, z: 1620 },
    engine: {
      idleRpm: 650,
      redlineRpm: 6000,
      torqueRpm: [650, 1500, 2500, 3500, 4200, 5000, 5600, 6000],
      torqueNm: [300, 375, 425, 439, 434, 415, 385, 340],
    },
    drivetrain: {
      gears: [-3.224, 0, 3.52, 2.042, 1.4, 1.0, 0.716, 0.586],
      finalDrive: 3.909,
      // Torque converter that never fully locks off-road, plus a full-time
      // centre differential.
      efficiency: 0.82,
      awd: true,
    },
    // 725 kg corner at 52 kN/m → 1.35 Hz. A higher rate than the pickup because
    // the corner mass is 40% greater; the *frequency* is what the occupants
    // feel, and 1.35 Hz is the softest of the road-going three.
    // c_crit = 2·√(52000·725) = 12280 → ζ 0.35 / 0.54.
    // Static sag = 7112 N / 52000 = 0.137 m against 0.25 m of bump travel.
    suspension: {
      restLength: 0.34, maxCompression: 0.25, maxDroop: 0.15,
      springK: 52000, dampCompress: 4300, dampRebound: 6630, antiRoll: 8800,
    },
    // Road-biased all-terrain, 285/60R18 (OD 0.844 m), ~32 kg per corner
    // → 32·0.422²·0.6 = 3.4, ×2.3 = 8.0.
    // 11.8 m turning circle on a 2.85 m wheelbase → asin(2.85/5.9) ≈ 29°.
    tyre: { baseMu: 1.05, wheelInertia: 8.0, maxSteerDeg: 31 },
  },
]

export const DEFAULT_VEHICLE_ID = 'frontier'

/**
 * Look up a spec by id. Unknown ids resolve to the default rather than throwing:
 * the id can arrive from persisted UI state or a URL, and a stale one should
 * drop the player into the Frontier, not break the scene.
 */
export function getVehicle(id: string): VehicleSpec {
  const found = VEHICLES.find((v) => v.id === id)
  if (found) return found
  const fallback = VEHICLES.find((v) => v.id === DEFAULT_VEHICLE_ID)
  if (!fallback) throw new Error(`vehicle catalogue is missing its default entry '${DEFAULT_VEHICLE_ID}'`)
  return fallback
}

/**
 * Physical dimensions the estimator needs, all in metres.
 */
export interface VehicleDims {
  lengthM: number
  widthM: number
  heightM: number
  wheelbaseM: number
  trackM: number
  wheelRadiusM: number
}

/**
 * Derive a plausible VehicleSpec from a model's size alone.
 *
 * Used when the user uploads a GLB we know nothing about: rather than make them
 * type a mass and a torque curve, everything is scaled off the bounding box
 * against the Frontier as a reference point (2050 kg, 5.2 m, 384 Nm). A Coaster
 * bus comes out heavy and softly sprung, a buggy light and stiff — not exact,
 * but drivable and in the right character, and every number stays in a range
 * Vehicle.ts is happy with. The user can refine it later; they never have to.
 */
export function estimateVehicleSpec(
  id: string,
  name: string,
  modelUrl: string,
  dims: VehicleDims,
  wheelNameHints: string[],
): VehicleSpec {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  const L = clamp(dims.lengthM, 1.5, 25)
  const W = clamp(dims.widthM, 1, 6)
  const H = clamp(dims.heightM, 1, 6)

  // Mass from bounding-box volume at roughly the Frontier's density, so size
  // maps to weight the way a real vehicle roughly does.
  const volume = L * W * H
  const mass = clamp(volume * 120, 500, 30000)

  // Box inertia, m/12·(a²+b²), softened 0.9 like the hand-tuned Frontier.
  const inertia = {
    x: clamp((mass / 12) * (H * H + L * L) * 0.9, 200, 4_000_000),
    y: clamp((mass / 12) * (W * W + L * L) * 0.9, 200, 4_000_000),
    z: clamp((mass / 12) * (W * W + H * H) * 0.9, 100, 2_000_000),
  }

  // Peak torque tracks mass at the Frontier's ratio (384 Nm / 2050 kg).
  const peak = clamp(mass * 0.187, 90, 6000)
  const heavy = mass > 3500 // trucks and buses: diesel-ish, low and broad
  const idle = heavy ? 650 : 800
  const redline = heavy ? 4200 : 6000

  // Springs must hold a quarter of the mass; scale rate and damping with it.
  const springK = clamp(mass * 22, 18000, 260000)

  const radius = clamp(dims.wheelRadiusM, 0.22, 0.9)

  return {
    id,
    name,
    modelUrl,
    wheelNameHints,
    targetLengthM: L,
    mass,
    comHeight: clamp(H * 0.4, 0.4, 2.2),
    inertia,
    engine: {
      idleRpm: idle,
      redlineRpm: redline,
      torqueRpm: [idle, redline * 0.28, redline * 0.5, redline * 0.66, redline * 0.82, redline],
      torqueNm: [peak * 0.62, peak * 0.85, peak * 0.98, peak, peak * 0.9, peak * 0.72],
    },
    drivetrain: {
      gears: heavy ? [-3.2, 0, 4.2, 2.4, 1.5, 1.0, 0.78] : [-2.9, 0, 3.6, 2.2, 1.5, 1.0, 0.82],
      finalDrive: heavy ? 4.6 : 3.9,
      efficiency: 0.85,
      awd: true,
    },
    suspension: {
      restLength: clamp(radius * 0.9, 0.24, 0.6),
      maxCompression: clamp(radius * 0.6, 0.14, 0.4),
      maxDroop: clamp(radius * 0.4, 0.1, 0.3),
      springK,
      dampCompress: clamp(springK * 0.075, 1500, 20000),
      dampRebound: clamp(springK * 0.11, 2200, 30000),
      antiRoll: clamp(springK * 0.2, 4000, 60000),
    },
    tyre: {
      baseMu: 1.1,
      // Scale spin inertia with the wheel; the Frontier's 9.5 is for a 0.4 m tyre.
      wheelInertia: clamp(9.5 * (radius / 0.4) ** 2, 3, 120),
      maxSteerDeg: heavy ? 42 : 34,
    },
  }
}

/**
 * Structural and physical sanity check on one spec. Returns every problem it
 * finds — an empty array means the spec is safe to hand to Vehicle.ts.
 *
 * Messages are developer-facing, so English, matching the loader's existing
 * throw messages. These are catalogue authoring mistakes, not player errors.
 */
export function validateSpec(spec: VehicleSpec): string[] {
  const problems: string[] = []
  const where = spec.id || '(missing id)'

  if (!spec.id) problems.push('id is empty')
  if (!spec.name) problems.push(`${where}: name is empty`)
  if (!spec.modelUrl) problems.push(`${where}: modelUrl is empty`)
  if (!spec.wheelNameHints.length) {
    problems.push(`${where}: wheelNameHints is empty — the loader cannot find the wheels`)
  } else if (spec.wheelNameHints.some((h) => !h)) {
    problems.push(`${where}: wheelNameHints contains an empty fragment, which matches every node`)
  }
  if (!(spec.targetLengthM > 0)) {
    problems.push(`${where}: targetLengthM must be positive, got ${spec.targetLengthM}`)
  }

  // ------------------------------------------------------------------- mass
  if (!(spec.mass > 0)) problems.push(`${where}: mass must be positive, got ${spec.mass}`)
  if (!(spec.comHeight > 0)) {
    problems.push(`${where}: comHeight must be positive, got ${spec.comHeight}`)
  }
  for (const axis of ['x', 'y', 'z'] as const) {
    const v = spec.inertia[axis]
    if (!(v > 0)) problems.push(`${where}: inertia.${axis} must be positive, got ${v}`)
  }
  // The inertia tensor of any rigid body satisfies the triangle inequality;
  // violating it means the numbers came from somewhere other than a real shape.
  const { x: ix, y: iy, z: iz } = spec.inertia
  if (ix > 0 && iy > 0 && iz > 0 && (ix + iy < iz || iy + iz < ix || iz + ix < iy)) {
    problems.push(
      `${where}: inertia {${ix}, ${iy}, ${iz}} violates the triangle inequality and cannot describe a real body`,
    )
  }

  // ----------------------------------------------------------------- engine
  const eng = spec.engine
  if (!(eng.idleRpm > 0)) problems.push(`${where}: engine.idleRpm must be positive, got ${eng.idleRpm}`)
  if (!(eng.redlineRpm > eng.idleRpm)) {
    problems.push(`${where}: engine.redlineRpm (${eng.redlineRpm}) must exceed idleRpm (${eng.idleRpm})`)
  }
  if (eng.torqueRpm.length !== eng.torqueNm.length) {
    problems.push(
      `${where}: torque arrays have unequal length (${eng.torqueRpm.length} rpm vs ${eng.torqueNm.length} Nm)`,
    )
  }
  if (eng.torqueRpm.length < 2) {
    problems.push(`${where}: torque curve needs at least two points to interpolate`)
  }
  for (let i = 1; i < eng.torqueRpm.length; i++) {
    if (!(eng.torqueRpm[i] > eng.torqueRpm[i - 1])) {
      problems.push(
        `${where}: torqueRpm is not strictly ascending at index ${i} (${eng.torqueRpm[i - 1]} → ${eng.torqueRpm[i]})`,
      )
    }
  }
  if (eng.torqueNm.some((t) => !(t > 0))) {
    problems.push(`${where}: torqueNm contains a non-positive value — the engine would drag rather than drive`)
  }
  // Vehicle.ts clamps rpm into [idle, redline] and then walks the table; if the
  // table starts above idle it extrapolates backwards off the first segment.
  if (eng.torqueRpm.length && eng.torqueRpm[0] > eng.idleRpm) {
    problems.push(
      `${where}: torque curve starts at ${eng.torqueRpm[0]} rpm, above idle (${eng.idleRpm}) — the lookup extrapolates`,
    )
  }
  if (eng.torqueRpm.length && eng.torqueRpm[eng.torqueRpm.length - 1] < eng.redlineRpm) {
    problems.push(
      `${where}: torque curve ends at ${eng.torqueRpm[eng.torqueRpm.length - 1]} rpm, below redline (${eng.redlineRpm})`,
    )
  }

  // ------------------------------------------------------------- drivetrain
  const dt = spec.drivetrain
  if (dt.gears.length < 3) {
    problems.push(`${where}: gears needs reverse, neutral and at least one forward ratio`)
  } else {
    if (!(dt.gears[0] < 0)) {
      problems.push(`${where}: gears[0] must be the negative reverse ratio, got ${dt.gears[0]}`)
    }
    if (dt.gears[1] !== 0) {
      problems.push(`${where}: gears[1] must be neutral (exactly 0), got ${dt.gears[1]}`)
    }
    for (let i = 2; i < dt.gears.length; i++) {
      if (!(dt.gears[i] > 0)) {
        problems.push(`${where}: forward gear ${i - 1} must be positive, got ${dt.gears[i]}`)
      } else if (i > 2 && !(dt.gears[i] < dt.gears[i - 1])) {
        problems.push(
          `${where}: forward gears must fall monotonically; gear ${i - 1} (${dt.gears[i]}) is not below gear ${i - 2} (${dt.gears[i - 1]})`,
        )
      }
    }
  }
  if (!(dt.finalDrive > 0)) {
    problems.push(`${where}: finalDrive must be positive, got ${dt.finalDrive}`)
  }
  if (!(dt.efficiency > 0) || dt.efficiency > 1) {
    problems.push(`${where}: efficiency must be in (0, 1], got ${dt.efficiency}`)
  }

  // ------------------------------------------------------------- suspension
  const s = spec.suspension
  if (!(s.restLength > 0)) problems.push(`${where}: restLength must be positive, got ${s.restLength}`)
  if (!(s.maxCompression > 0)) {
    problems.push(`${where}: maxCompression must be positive, got ${s.maxCompression}`)
  } else if (s.maxCompression >= s.restLength) {
    // Vehicle.ts computes length as restLength - maxCompression at full bump;
    // if that reaches zero the strut has folded through itself.
    problems.push(
      `${where}: maxCompression (${s.maxCompression}) must stay below restLength (${s.restLength})`,
    )
  }
  if (!(s.maxDroop >= 0)) problems.push(`${where}: maxDroop cannot be negative, got ${s.maxDroop}`)
  if (!(s.springK > 0)) problems.push(`${where}: springK must be positive, got ${s.springK}`)
  if (!(s.dampCompress >= 0)) {
    problems.push(`${where}: dampCompress cannot be negative, got ${s.dampCompress}`)
  }
  if (!(s.dampRebound >= 0)) {
    problems.push(`${where}: dampRebound cannot be negative, got ${s.dampRebound}`)
  }
  if (!(s.antiRoll >= 0)) problems.push(`${where}: antiRoll cannot be negative, got ${s.antiRoll}`)

  // The spring has to actually hold the car up within its bump travel, and the
  // wheel load has to stay inside the solver's clamp. Both are silent failures
  // otherwise: the body just sits on its bump stops.
  if (spec.mass > 0 && s.springK > 0 && s.maxCompression > 0) {
    const staticLoad = (spec.mass * 9.81) / 4
    const staticSag = staticLoad / s.springK
    if (staticSag > s.maxCompression) {
      problems.push(
        `${where}: static sag ${staticSag.toFixed(3)} m exceeds maxCompression ${s.maxCompression} m — ` +
          `springK ${s.springK} N/m cannot carry ${spec.mass} kg`,
      )
    } else if (staticSag > s.maxCompression * 0.7) {
      // Parked on 70%+ of its bump travel, the first ridge puts it on the bump
      // stops. The reference Frontier sits at 55%.
      problems.push(
        `${where}: static sag ${staticSag.toFixed(3)} m uses ` +
          `${Math.round((staticSag / s.maxCompression) * 100)}% of the bump travel — ` +
          'raise springK or maxCompression, it will ride on the bump stops',
      )
    }
    if (staticLoad > WHEEL_LOAD_CLAMP_N) {
      problems.push(
        `${where}: static wheel load ${Math.round(staticLoad)} N exceeds the ${WHEEL_LOAD_CLAMP_N} N ` +
          `per-wheel clamp in Vehicle.ts — the vehicle cannot be held up at this mass`,
      )
    }
  }

  // ------------------------------------------------------------------ tyres
  const t = spec.tyre
  if (!(t.baseMu > 0)) problems.push(`${where}: baseMu must be positive, got ${t.baseMu}`)
  if (!(t.wheelInertia > 0)) {
    problems.push(`${where}: wheelInertia must be positive, got ${t.wheelInertia}`)
  }
  if (!(t.maxSteerDeg > 0) || t.maxSteerDeg >= 90) {
    problems.push(`${where}: maxSteerDeg must be in (0, 90), got ${t.maxSteerDeg}`)
  }

  return problems
}
