import { Quaternion, Vector3 } from '@babylonjs/core'
import type RAPIER_NS from '@dimforge/rapier3d-compat'
import type { MudField } from './MudField'
import type { Input } from './Input'
import type { LoadedVehicle, WheelId, WheelRig } from './VehicleModel'
import { DEFAULT_VEHICLE_ID, getVehicle, type VehicleSpec } from './vehicleCatalog'

/**
 * Raycast vehicle with a proper drivetrain.
 *
 * Rapier owns the chassis rigid body; the wheels are not physics objects. Each
 * wheel casts a ray at the MudField analytically, so a rut the tyre carved a
 * moment ago is felt on the next pass without rebuilding any collider.
 *
 * Per wheel, every substep:
 *   1. cast down the suspension axis, find the mud surface
 *   2. spring + damper → normal load
 *   3. integrate wheel spin against drive/brake torque and tyre reaction
 *   4. slip ratio and slip angle → longitudinal and lateral force
 *   5. clamp the pair to the friction circle, subtract mud rolling resistance
 *   6. stamp the contact patch back into the mud
 */

const WHEEL_ORDER: WheelId[] = ['FL', 'FR', 'RL', 'RR']

/*
 * Gear-array layout. These are positions in VehicleSpec.drivetrain.gears, not
 * tuning, so they are the same for every car and stay module constants:
 * [reverse, neutral, 1st, 2nd, ...].
 */
const REVERSE_INDEX = 0
const NEUTRAL_INDEX = 1
const FIRST_GEAR_INDEX = 2

interface WheelState {
  rig: WheelRig
  /** Wheel spin rate, rad/s. */
  omega: number
  /** Accumulated spin angle for the visual. */
  angle: number
  /** Current suspension length. */
  length: number
  prevLength: number
  compression: number
  load: number
  grounded: boolean
  slipRatio: number
  slipAngle: number
  sink: number
  contact: Vector3
  normal: Vector3
  /** Distance rolled, drives the tread stamp phase. */
  travelled: number
  steerAngle: number
}

export interface VehicleTelemetry {
  speedKmh: number
  rpm: number
  gearLabel: string
  awd: boolean
  fuelPct: number
  damagePct: number
  engineTempC: number
  enginePct: number
  wheelSink: [number, number, number, number]
  bodyMud: number
  airborne: boolean
  slipMax: number
}

export interface VehicleTuning {
  mudIntensity: number
  humidity: number
  /** Ambient temperature, °C. */
  ambientC: number
  awd: boolean
}

export class Vehicle {
  readonly body: RAPIER_NS.RigidBody
  readonly model: LoadedVehicle

  private readonly rapier: typeof RAPIER_NS
  private readonly world: RAPIER_NS.World
  private readonly field: MudField
  private readonly wheels: WheelState[] = []

  /** Which car this is. Every number below is read from here, none hardcoded. */
  readonly spec: VehicleSpec

  // Unpacked from the spec once, because the substep loop touches most of these
  // several times per wheel per step and a property chain per read is waste.
  private readonly MASS: number
  private readonly ENGINE_IDLE: number
  private readonly ENGINE_REDLINE: number
  private readonly TORQUE_RPM: number[]
  private readonly TORQUE_NM: number[]
  private readonly GEARS: number[]
  private readonly FINAL_DRIVE: number
  private readonly DRIVELINE_EFF: number
  private readonly REST_LENGTH: number
  private readonly MAX_COMPRESSION: number
  private readonly MAX_DROOP: number
  private readonly SPRING_K: number
  private readonly DAMP_COMPRESS: number
  private readonly DAMP_REBOUND: number
  private readonly ANTIROLL: number
  private readonly WHEEL_INERTIA: number
  private readonly BASE_MU: number
  /** Radians. */
  private readonly MAX_STEER: number

  private gearIndex = NEUTRAL_INDEX
  private rpm: number
  private shiftCooldown = 0
  private fuel = 0.65
  private damage = 0
  private engineTemp = 62
  private bodyMud = 0
  private prevSpeed = 0
  private spawn: Vector3

  // Scratch vectors — the substep loop must not allocate.
  private readonly _v1 = new Vector3()
  private readonly _v2 = new Vector3()
  private readonly _v3 = new Vector3()
  private readonly _q = new Quaternion()
  private readonly _n = { x: 0, y: 1, z: 0 }

  constructor(
    rapier: typeof RAPIER_NS,
    world: RAPIER_NS.World,
    field: MudField,
    model: LoadedVehicle,
    spawn: Vector3,
    spec: VehicleSpec = getVehicle(DEFAULT_VEHICLE_ID),
  ) {
    this.rapier = rapier
    this.world = world
    this.field = field
    this.model = model
    this.spawn = spawn.clone()

    this.spec = spec
    this.MASS = spec.mass
    this.ENGINE_IDLE = spec.engine.idleRpm
    this.ENGINE_REDLINE = spec.engine.redlineRpm
    this.TORQUE_RPM = spec.engine.torqueRpm
    this.TORQUE_NM = spec.engine.torqueNm
    this.GEARS = spec.drivetrain.gears
    this.FINAL_DRIVE = spec.drivetrain.finalDrive
    this.DRIVELINE_EFF = spec.drivetrain.efficiency
    this.REST_LENGTH = spec.suspension.restLength
    this.MAX_COMPRESSION = spec.suspension.maxCompression
    this.MAX_DROOP = spec.suspension.maxDroop
    this.SPRING_K = spec.suspension.springK
    this.DAMP_COMPRESS = spec.suspension.dampCompress
    this.DAMP_REBOUND = spec.suspension.dampRebound
    this.ANTIROLL = spec.suspension.antiRoll
    this.WHEEL_INERTIA = spec.tyre.wheelInertia
    this.BASE_MU = spec.tyre.baseMu
    this.MAX_STEER = (spec.tyre.maxSteerDeg * Math.PI) / 180
    this.rpm = this.ENGINE_IDLE

    const he = model.halfExtents
    const bodyDesc = rapier.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setLinearDamping(0.06)
      .setAngularDamping(0.55)
      .setAdditionalMassProperties(
        this.MASS,
        // Centre of mass sits low for roll stability.
        { x: 0, y: spec.comHeight, z: 0 },
        spec.inertia,
        { x: 0, y: 0, z: 0, w: 1 },
      )
      .setCcdEnabled(true)
    this.body = world.createRigidBody(bodyDesc)

    const collider = rapier.ColliderDesc.cuboid(he.x * 0.92, 0.74, he.z * 0.94)
      .setTranslation(0, 1.02, 0)
      .setDensity(0)
      .setFriction(0.45)
      .setRestitution(0.04)
    world.createCollider(collider, this.body)

    for (const id of WHEEL_ORDER) {
      this.wheels.push({
        rig: model.wheels[id],
        omega: 0,
        angle: 0,
        length: this.REST_LENGTH,
        prevLength: this.REST_LENGTH,
        compression: 0,
        load: 0,
        grounded: false,
        slipRatio: 0,
        slipAngle: 0,
        sink: 0,
        contact: new Vector3(),
        normal: new Vector3(0, 1, 0),
        travelled: 0,
        steerAngle: 0,
      })
    }
  }

  // ------------------------------------------------------------------ helpers

  private torqueAt(rpm: number): number {
    const r = Math.min(this.ENGINE_REDLINE, Math.max(this.ENGINE_IDLE, rpm))
    for (let i = 1; i < this.TORQUE_RPM.length; i++) {
      if (r <= this.TORQUE_RPM[i]) {
        const t = (r - this.TORQUE_RPM[i - 1]) / (this.TORQUE_RPM[i] - this.TORQUE_RPM[i - 1])
        return this.TORQUE_NM[i - 1] + (this.TORQUE_NM[i] - this.TORQUE_NM[i - 1]) * t
      }
    }
    return this.TORQUE_NM[this.TORQUE_NM.length - 1]
  }

  /**
   * Cast down the suspension axis and find where it meets the mud surface.
   * The surface is a heightfield, so a coarse march plus a few bisections beats
   * any generic ray/triangle test — and it reads the live deformation directly.
   */
  private castGround(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxLen: number,
  ): number {
    const above = (t: number) =>
      oy + dy * t - this.field.surfaceHeight(ox + dx * t, oz + dz * t)

    let t0 = 0
    let a0 = above(0)
    if (a0 <= 0) return 0 // already buried

    const steps = 10
    const dt = maxLen / steps
    for (let i = 1; i <= steps; i++) {
      const t1 = i * dt
      const a1 = above(t1)
      if (a1 <= 0) {
        // Bisect for a smooth contact point — jitter here shows up as suspension noise.
        let lo = t0
        let hi = t1
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) * 0.5
          if (above(mid) > 0) lo = mid
          else hi = mid
        }
        return (lo + hi) * 0.5
      }
      t0 = t1
      a0 = a1
    }
    return -1 // no contact within reach
  }

  // -------------------------------------------------------------------- step

  /** One physics substep. `dt` is fixed by the caller. */
  step(dt: number, input: Input, tune: VehicleTuning) {
    const body = this.body

    // Rapier forces are PERSISTENT: addForce/addForceAtPoint keep applying on
    // every subsequent step until explicitly reset — unlike most engines, where
    // they are cleared each step. Without this, one frame of suspension load
    // becomes a permanent thruster and the truck accelerates away for ever.
    body.resetForces(false)
    body.resetTorques(false)
    const pos = body.translation()
    const rot = body.rotation()
    this._q.set(rot.x, rot.y, rot.z, rot.w)
    const rotM = new Vector3() // reused below via helper rotations

    const up = this._v1.copyFromFloats(0, 1, 0)
    up.applyRotationQuaternionInPlace(this._q)
    const fwd = this._v2.copyFromFloats(0, 0, 1)
    fwd.applyRotationQuaternionInPlace(this._q)
    const right = this._v3.copyFromFloats(1, 0, 0)
    right.applyRotationQuaternionInPlace(this._q)

    const linvel = body.linvel()
    const angvel = body.angvel()
    const speed = Math.hypot(linvel.x, linvel.z)
    const forwardSpeed = linvel.x * fwd.x + linvel.y * fwd.y + linvel.z * fwd.z

    // Soil state from the dashboard.
    const softness = Math.min(1, tune.mudIntensity * 0.65 + tune.humidity * 0.55)
    // Cold mud stiffens; hot mud dries out and firms up too.
    const tempFactor = 1 - Math.max(0, 1 - Math.abs(tune.ambientC - 14) / 30) * 0.18
    const soil = Math.min(1, softness * tempFactor)

    // Speed-sensitive steering, plus a little Ackermann split.
    const steerLimit = this.MAX_STEER / (1 + speed * 0.045)
    const steerCmd = input.steer * steerLimit

    // ------------------------------------------------------ suspension pass
    let totalLoad = 0
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i]
      const isFront = w.rig.id[0] === 'F'
      const isLeft = w.rig.id[1] === 'L'
      w.steerAngle = isFront
        ? steerCmd * (isLeft === steerCmd < 0 ? 1.12 : 0.9)
        : 0

      const rest = w.rig.restPosition
      // Mount point = wheel centre at rest, raised by the spring's rest length.
      const mx = rest.x
      const my = rest.y + this.REST_LENGTH
      const mz = rest.z
      const wx = pos.x + right.x * mx + up.x * my + fwd.x * mz
      const wy = pos.y + right.y * mx + up.y * my + fwd.y * mz
      const wz = pos.z + right.z * mx + up.z * my + fwd.z * mz

      const maxReach = this.REST_LENGTH + this.MAX_DROOP + w.rig.radius
      const t = this.castGround(wx, wy, wz, -up.x, -up.y, -up.z, maxReach)

      const wasGrounded = w.grounded
      w.prevLength = w.length
      if (t < 0) {
        w.grounded = false
        w.length = this.REST_LENGTH + this.MAX_DROOP
        w.compression = 0
        w.load = 0
        w.sink = 0
        continue
      }

      const rawLength = t - w.rig.radius
      w.length = Math.min(this.REST_LENGTH + this.MAX_DROOP, Math.max(this.REST_LENGTH - this.MAX_COMPRESSION, rawLength))
      w.compression = this.REST_LENGTH - w.length
      w.grounded = true
      // Touching down after air time: the spring goes from full droop to
      // compressed in one step. Taking that as a damper velocity would produce a
      // six-figure force and launch the truck, so treat the first contact step as
      // having zero damper velocity and let the spring do the work.
      if (!wasGrounded) w.prevLength = w.length

      const cx = wx - up.x * t
      const cy = wy - up.y * t
      const cz = wz - up.z * t
      w.contact.copyFromFloats(cx, cy, cz)
      this.field.normalAt(cx, cz, this._n)
      w.normal.copyFromFloats(this._n.x, this._n.y, this._n.z)
      w.sink = Math.min(1, this.field.depthAt(cx, cz) / 0.4)

      // Spring + asymmetric damper. Real dampers see a few m/s; clamping here
      // keeps a single bad step from turning into an impulse.
      const vel = Math.max(-6, Math.min(6, (w.prevLength - w.length) / dt))
      const damp = vel > 0 ? this.DAMP_COMPRESS : this.DAMP_REBOUND
      let force = this.SPRING_K * w.compression + damp * vel
      // Bump stop at full compression. Deliberately soft and capped: a wheel that
      // ends up well below the surface must not be pushed out by brute force —
      // that is what the positional recovery below is for.
      const overlap = this.REST_LENGTH - this.MAX_COMPRESSION - rawLength
      if (overlap > 0) force += Math.min(20000, overlap * 60000)
      // Static load per wheel is ~5 kN. 26 kN absorbs real impacts without
      // letting one corner throw the whole vehicle.
      w.load = Math.max(0, Math.min(force, 26000))
      totalLoad += w.load
    }

    // Anti-roll bars: transfer load across each axle to resist body roll.
    for (const [a, b] of [[0, 1], [2, 3]] as const) {
      const wa = this.wheels[a]
      const wb = this.wheels[b]
      const delta = wa.compression - wb.compression
      const f = delta * this.ANTIROLL
      if (wa.grounded) wa.load = Math.max(0, wa.load - f)
      if (wb.grounded) wb.load = Math.max(0, wb.load + f)
    }

    // --------------------------------------------------------- drivetrain
    const driven = tune.awd ? this.wheels : this.wheels.slice(2)
    let avgOmega = 0
    let drivenGrounded = 0
    for (const w of driven) {
      avgOmega += w.omega
      if (w.grounded) drivenGrounded++
    }
    avgOmega /= driven.length

    const gearRatio = this.GEARS[this.gearIndex]
    const inGear = this.gearIndex !== NEUTRAL_INDEX
    if (inGear) {
      const ratio = Math.abs(gearRatio) * this.FINAL_DRIVE
      this.rpm = Math.max(this.ENGINE_IDLE, Math.abs(avgOmega) * ratio * (60 / (2 * Math.PI)))
    } else {
      this.rpm += (this.ENGINE_IDLE + input.throttle * 3000 - this.rpm) * Math.min(1, dt * 4)
    }
    this.rpm = Math.min(this.rpm, this.ENGINE_REDLINE)

    // Automatic gearbox.
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt)
    if (this.shiftCooldown === 0) {
      const wantReverse = input.brake > 0.5 && forwardSpeed < 0.6
      const wantForward = input.throttle > 0.1 && forwardSpeed > -0.6
      if (wantReverse && this.gearIndex !== REVERSE_INDEX) {
        this.gearIndex = REVERSE_INDEX
        this.shiftCooldown = 0.4
      } else if (wantForward && this.gearIndex === REVERSE_INDEX) {
        this.gearIndex = FIRST_GEAR_INDEX
        this.shiftCooldown = 0.4
      } else if (this.gearIndex >= FIRST_GEAR_INDEX) {
        // Gate upshifts on road speed, not just revs: a bogged truck spins its
        // wheels to the redline while going nowhere, and must not shift up.
        const movingEnough = Math.abs(forwardSpeed) > 2.5
        if (this.rpm > 5400 && movingEnough && this.gearIndex < this.GEARS.length - 1) {
          this.gearIndex++
          this.shiftCooldown = 0.55
        } else if (this.rpm < 1500 && this.gearIndex > FIRST_GEAR_INDEX) {
          this.gearIndex--
          this.shiftCooldown = 0.45
        }
      } else if (this.gearIndex === NEUTRAL_INDEX && input.throttle > 0.05) {
        this.gearIndex = FIRST_GEAR_INDEX
        this.shiftCooldown = 0.3
      }
    }

    const fuelAvailable = this.fuel > 0
    const engineTorque = fuelAvailable ? this.torqueAt(this.rpm) * input.throttle : 0
    const axleTorque = inGear
      ? engineTorque * gearRatio * this.FINAL_DRIVE * this.DRIVELINE_EFF
      : 0
    // Open-ish differential: torque splits evenly, so one spinning wheel does
    // rob the others — which is exactly the off-road failure mode we want.
    const perWheelTorque = axleTorque / Math.max(1, driven.length)

    const brakeTorque = input.brake * 5200 + (input.handbrake ? 6000 : 0)

    // ---------------------------------------------------------- tyre forces
    let slipMax = 0
    let sinkSum = 0

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i]
      const r = w.rig.radius
      const isDriven = tune.awd || i >= 2
      const isRear = i >= 2

      if (!w.grounded) {
        // Free-spinning wheel: drive torque only, plus a little drag.
        const tq = (isDriven ? perWheelTorque : 0) - Math.sign(w.omega) * (brakeTorque * (isRear ? 1 : 0.85))
        w.omega += (tq / this.WHEEL_INERTIA) * dt
        w.omega *= 1 - Math.min(0.5, dt * 0.8)
        w.angle += w.omega * dt
        continue
      }

      // Contact-patch velocity of the chassis.
      const rx = w.contact.x - pos.x
      const ry = w.contact.y - pos.y
      const rz = w.contact.z - pos.z
      const vx = linvel.x + (angvel.y * rz - angvel.z * ry)
      const vy = linvel.y + (angvel.z * rx - angvel.x * rz)
      const vz = linvel.z + (angvel.x * ry - angvel.y * rx)

      // Wheel axes, steered and projected onto the contact plane.
      const sa = w.steerAngle
      const cs = Math.cos(sa)
      const sn = Math.sin(sa)
      let fx = fwd.x * cs + right.x * sn
      let fy = fwd.y * cs + right.y * sn
      let fz = fwd.z * cs + right.z * sn
      const n = w.normal
      const dotF = fx * n.x + fy * n.y + fz * n.z
      fx -= n.x * dotF
      fy -= n.y * dotF
      fz -= n.z * dotF
      const fl = Math.hypot(fx, fy, fz) || 1
      fx /= fl; fy /= fl; fz /= fl
      // Right = normal × forward.
      const gx = n.y * fz - n.z * fy
      const gy = n.z * fx - n.x * fz
      const gz = n.x * fy - n.y * fx

      const vLong = vx * fx + vy * fy + vz * fz
      const vLat = vx * gx + vy * gy + vz * gz

      // Grip: mud is slick, and a deeply sunk tyre loses the surface entirely.
      const wetLoss = 1 - tune.humidity * 0.34
      const mudLoss = 1 - w.sink * soil * 0.5
      const mu = this.BASE_MU * wetLoss * mudLoss
      const fMax = mu * w.load

      // --- drivetrain torque into the wheel, before the tyre reacts ---------
      const driveT = isDriven ? perWheelTorque : 0
      let brakeT = 0
      if (brakeTorque > 0) {
        const bt = brakeTorque * (isRear ? 1 : 1.15) * (input.handbrake && !isRear ? 0 : 1)
        // Cap the brake so it can never spin the wheel backwards in one step.
        const stopT = (Math.abs(w.omega) * this.WHEEL_INERTIA) / dt
        brakeT = -Math.sign(w.omega) * Math.min(bt, stopT)
      }
      w.omega += ((driveT + brakeT) / this.WHEEL_INERTIA) * dt

      /*
       * Impulse-based tyre. A force-curve model (slip ratio → force) is a stiff
       * ODE at low speed: the slip ratio divides by ground speed, so near
       * standstill a tiny change in wheel spin swings the force across the whole
       * friction circle and the chassis oscillates itself into orbit.
       *
       * Instead, solve for the force that would bring the contact patch to zero
       * slip within this step, accounting for both the chassis mass carried by
       * this corner and the wheel's own inertia, then clamp that to the friction
       * circle. Below the limit it behaves as static friction; above it, it
       * saturates and the tyre slides. Unconditionally stable at any speed.
       */
      const mEff = Math.max(180, w.load / 9.81)
      const slipVel = w.omega * r - vLong
      const invLong = 1 / mEff + (r * r) / this.WHEEL_INERTIA
      let fLong = slipVel / (dt * invLong)
      let fLat = (-vLat * mEff) / dt

      const mag = Math.hypot(fLong, fLat)
      if (mag > fMax && mag > 0) {
        const k = fMax / mag
        fLong *= k
        fLat *= k
      }

      // Reported slip: how far past the friction limit the tyre is being asked
      // to work. 0 = gripping, 1 = fully sliding.
      w.slipRatio = mag > 0 ? Math.min(2, mag / Math.max(1, fMax)) - 1 : 0
      w.slipAngle = Math.atan2(-vLat, Math.max(0.6, Math.abs(vLong)))

      // Rolling resistance from ploughing through mud. Scales with sinkage —
      // this is what makes a deep rut genuinely hard to climb out of. Tuned to
      // stay below the available traction at moderate sink, so the truck bogs
      // down when it digs itself in rather than being immovable from the start.
      const plough = w.sink * soil * (250 + w.load * 0.09)
      if (Math.abs(vLong) > 0.05) {
        const maxResist = (Math.abs(vLong) * mEff) / dt
        fLong -= Math.sign(vLong) * Math.min(plough, maxResist)
      }

      // Tyre reaction back onto the wheel.
      w.omega -= ((fLong * r) / this.WHEEL_INERTIA) * dt
      // Engine braking / driveline drag when coasting.
      if (input.throttle < 0.02 && inGear) w.omega *= 1 - Math.min(0.4, dt * 1.1)
      w.angle += w.omega * dt
      w.travelled += Math.abs(w.omega * r) * dt

      slipMax = Math.max(slipMax, Math.min(1, Math.abs(w.slipRatio) / 1.5))
      sinkSum += w.sink

      // ------------------------------------------------------ apply forces
      const forceX = n.x * w.load + fx * fLong + gx * fLat
      const forceY = n.y * w.load + fy * fLong + gy * fLat
      const forceZ = n.z * w.load + fz * fLong + gz * fLat
      body.addForceAtPoint(
        { x: forceX, y: forceY, z: forceZ },
        { x: w.contact.x, y: w.contact.y, z: w.contact.z },
        true,
      )

      // ------------------------------------------------------- carve the mud
      const stampSlip = Math.min(1, Math.abs(w.slipRatio) * 0.8)
      const moving = Math.abs(vLong) > 0.08 || stampSlip > 0.05
      if (moving && w.load > 200) {
        const dirLen = Math.hypot(fx, fz) || 1
        this.field.stampWheel(
          w.contact.x,
          w.contact.z,
          fx / dirLen,
          fz / dirLen,
          w.rig.width * 0.5,
          w.load,
          soil,
          stampSlip,
          w.travelled,
        )
      }
    }

    /*
     * Chassis backstop. The wheels are the real ground contact; this catches the
     * cases they can't — a hard landing that bottoms out the springs, or a
     * roll-over where the body is the only thing touching. Ground truth is the
     * same MudField the wheels read, so there is no second collision
     * representation to keep in register.
     *
     * Resolved positionally, not with a force. A force stiff enough to push a
     * buried chassis out within one step is also stiff enough to fire it into
     * the sky; lifting by the overlap at a bounded rate and killing only the
     * downward velocity can never add energy.
     */
    {
      const he = this.model.halfExtents
      const bx = he.x * 0.88
      const bz = he.z * 0.9
      const by = 0.42 // underside of the chassis in body space
      const corners = [
        [-bx, by, -bz], [bx, by, -bz], [-bx, by, bz], [bx, by, bz], [0, by, 0],
      ] as const
      let deepest = 0
      for (const [lx, ly, lz] of corners) {
        const wx = pos.x + right.x * lx + up.x * ly + fwd.x * lz
        const wy = pos.y + right.y * lx + up.y * ly + fwd.y * lz
        const wz = pos.z + right.z * lx + up.z * ly + fwd.z * lz
        const pen = this.field.surfaceHeight(wx, wz) - wy
        if (pen > deepest) deepest = pen
      }
      if (deepest > 0.005) {
        // Recover at most 2.5 m/s, so a deep overlap eases out over a few steps.
        const lift = Math.min(deepest, 2.5 * dt)
        body.setTranslation({ x: pos.x, y: pos.y + lift, z: pos.z }, true)
        if (linvel.y < 0) body.setLinvel({ x: linvel.x, y: 0, z: linvel.z }, true)
      }
    }

    // ------------------------------------------------------------- systems
    // Fuel: idle burn plus load-proportional burn.
    if (fuelAvailable) {
      this.fuel = Math.max(0, this.fuel - (0.0000045 + input.throttle * (this.rpm / 6000) * 0.000075) * dt * 60)
    }

    // Engine temperature: load heats it, airflow and cold ambient cool it.
    const loadHeat = input.throttle * (this.rpm / this.ENGINE_REDLINE) * 46
    const cooling = (this.engineTemp - tune.ambientC) * (0.06 + speed * 0.011)
    this.engineTemp += (loadHeat - cooling) * dt * 0.4
    this.engineTemp = Math.max(tune.ambientC, Math.min(128, this.engineTemp))

    // Impact damage from sudden speed loss.
    const decel = (this.prevSpeed - speed) / dt
    if (decel > 26) this.damage = Math.min(1, this.damage + (decel - 26) * 0.0016)
    this.prevSpeed = speed

    // Mud coating builds while driving through churn, washes off in the wet.
    const avgSink = sinkSum / 4
    const pickup = avgSink * soil * Math.min(1, speed / 6) * 0.13
    const wash = tune.humidity * 0.035 * (speed > 3 ? 1 : 0.25)
    this.bodyMud = Math.max(0, Math.min(1, this.bodyMud + (pickup - wash) * dt))

    // Divergence guard. The tyre model is stable by construction, but a bad
    // spawn or a pathological contact should degrade to "put it back on the
    // track", never to a truck in orbit.
    const p2 = body.translation()
    const v2 = body.linvel()
    const bound = this.field.worldSize * 0.5 + 20
    if (
      !Number.isFinite(p2.x) || !Number.isFinite(p2.y) || !Number.isFinite(p2.z) ||
      Math.hypot(v2.x, v2.y, v2.z) > 140 ||
      p2.y > 300 || p2.y < -200 ||
      Math.abs(p2.x) > bound || Math.abs(p2.z) > bound
    ) {
      this.reset()
    }

    void rotM
    void totalLoad
    void drivenGrounded
    this.lastSlipMax = slipMax
  }

  private lastSlipMax = 0

  /** Push the physics pose onto the visual rig. Called once per rendered frame. */
  syncVisuals() {
    const pos = this.body.translation()
    const rot = this.body.rotation()
    const root = this.model.root
    root.position.copyFromFloats(pos.x, pos.y, pos.z)
    if (!root.rotationQuaternion) root.rotationQuaternion = new Quaternion()
    root.rotationQuaternion.copyFromFloats(rot.x, rot.y, rot.z, rot.w)

    for (const w of this.wheels) {
      const rig = w.rig
      // steer/spin live in the rig's local frame, which may be flipped 180°
      // relative to the normalised frame the physics works in.
      rig.steer.position.y = rig.localRest.y + w.compression
      rig.steer.rotation.y = w.steerAngle
      rig.spin.rotation.x = w.angle * rig.spinSign
    }
  }

  /** Per-wheel state, for the diagnostics harness. */
  debugWheels() {
    return {
      mass: this.body.mass(),
      wheels: this.wheels.map((w) => ({
        id: w.rig.id,
        grounded: w.grounded,
        length: +w.length.toFixed(3),
        compression: +w.compression.toFixed(3),
        load: Math.round(w.load),
        omega: +w.omega.toFixed(1),
        normalY: +w.normal.y.toFixed(3),
      })),
    }
  }

  getTelemetry(): VehicleTelemetry {
    const v = this.body.linvel()
    const speed = Math.hypot(v.x, v.z)
    const gearLabel =
      this.gearIndex === REVERSE_INDEX ? 'R'
      : this.gearIndex === NEUTRAL_INDEX ? 'N'
      : `D${this.gearIndex - FIRST_GEAR_INDEX + 1}`

    return {
      speedKmh: speed * 3.6,
      rpm: this.rpm,
      gearLabel,
      awd: this.spec.drivetrain.awd,
      fuelPct: this.fuel * 100,
      damagePct: this.damage * 100,
      engineTempC: this.engineTemp,
      enginePct: Math.max(0, 100 - this.damage * 70),
      wheelSink: [
        this.wheels[0].sink,
        this.wheels[1].sink,
        this.wheels[2].sink,
        this.wheels[3].sink,
      ],
      bodyMud: this.bodyMud,
      airborne: this.wheels.every((w) => !w.grounded),
      slipMax: this.lastSlipMax,
    }
  }

  /**
   * Drop the truck back at the spawn point, upright and stationary. An optional
   * `yaw` (radians about +Y) orients it — used when a hijacked car should keep
   * the heading of the NPC car it replaced.
   */
  reset(at?: Vector3, yaw = 0) {
    const p = at ?? this.spawn
    const he = this.model.halfExtents
    let top = -Infinity
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        top = Math.max(top, this.field.surfaceHeight(p.x + i * he.x, p.z + j * he.z))
      }
    }
    const y = top + this.wheels[0].rig.radius + 0.36
    this.body.setTranslation({ x: p.x, y, z: p.z }, true)
    // Yaw-only quaternion about +Y: (0, sin(yaw/2), 0, cos(yaw/2)).
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true)
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    this.body.resetForces(true)
    this.body.resetTorques(true)
    for (const w of this.wheels) {
      w.omega = 0
      w.length = this.REST_LENGTH
      w.prevLength = this.REST_LENGTH
    }
    this.gearIndex = NEUTRAL_INDEX
    this.rpm = this.ENGINE_IDLE
    void this.world
    void this.rapier
  }

  get position(): Vector3 {
    const t = this.body.translation()
    return new Vector3(t.x, t.y, t.z)
  }
}
