import type RAPIER from '@dimforge/rapier3d-compat'
import { clamp, damp } from '../engine/math'
import type { Terrain, SurfaceSample } from '../world/terrain'

/**
 * Raycast vehicle.
 *
 * Each wheel is an independent spring/damper probing the ground beneath it.
 * Nothing here explicitly tilts the chassis: when one wheel drops into a rut
 * its spring extends while the other three stay loaded, and the resulting
 * force imbalance rolls the body. Ride over a stone and that wheel's spring
 * compresses, lifting its corner. The behaviour the player feels is emergent,
 * which is why it reads as real rather than scripted.
 */

export interface WheelConfig {
  /** Suspension mount point in chassis-local space (metres). */
  x: number
  y: number
  z: number
  radius: number
  width: number
  steered: boolean
  driven: boolean
  /** Share of total brake torque, 0..1. */
  brakeBias: number
  /** Handbrake acts on the rear only. */
  handbrake: boolean
}

export interface VehicleSpec {
  mass: number
  /** Half-extents of the chassis collider. */
  bodyHalfWidth: number
  bodyHalfHeight: number
  bodyHalfLength: number
  /** Centre of mass offset from the collider centre — lower is more stable. */
  centreOfMassY: number
  wheels: WheelConfig[]
  suspensionRestLength: number
  suspensionStiffness: number
  suspensionDamping: number
  /** Hard limit on travel beyond rest, before the bump stop bites. */
  suspensionMaxTravel: number
  enginePower: number
  brakeTorque: number
  handbrakeTorque: number
  maxSteerAngle: number
  /** Steering authority falls off with speed so the truck is not twitchy. */
  steerSpeedFalloff: number
  topSpeed: number
  /** Base tyre grip on dry ground; mud scales this down. */
  tyreGrip: number
  rollingResistance: number
  dragCoefficient: number
  downforce: number
}

export const PICKUP_SPEC: VehicleSpec = {
  mass: 2050,
  bodyHalfWidth: 0.86,
  bodyHalfHeight: 0.62,
  bodyHalfLength: 2.62,
  centreOfMassY: -0.34,
  suspensionRestLength: 0.46,
  suspensionStiffness: 46000,
  suspensionDamping: 4200,
  suspensionMaxTravel: 0.26,
  enginePower: 18000,
  brakeTorque: 12000,
  handbrakeTorque: 9000,
  maxSteerAngle: 0.62,
  steerSpeedFalloff: 0.055,
  topSpeed: 42,
  tyreGrip: 1.6,
  rollingResistance: 11,
  dragCoefficient: 2.6,
  downforce: 8,
  // Mounts sit outboard of the body half-width so the tyres stand proud of the
  // panels the way they do under real wheel arches.
  wheels: [
    { x: -0.94, y: -0.3, z: 1.62, radius: 0.39, width: 0.27, steered: true, driven: false, brakeBias: 0.32, handbrake: false },
    { x: 0.94, y: -0.3, z: 1.62, radius: 0.39, width: 0.27, steered: true, driven: false, brakeBias: 0.32, handbrake: false },
    { x: -0.94, y: -0.3, z: -1.52, radius: 0.39, width: 0.29, steered: false, driven: true, brakeBias: 0.18, handbrake: true },
    { x: 0.94, y: -0.3, z: -1.52, radius: 0.39, width: 0.29, steered: false, driven: true, brakeBias: 0.18, handbrake: true },
  ],
}

export interface VehicleControls {
  /** -1 (full left) .. 1 (full right). */
  steer: number
  /** 0..1 */
  throttle: number
  /** 0..1 */
  brake: number
  /** 0..1 */
  handbrake: boolean
}

export interface WheelState {
  config: WheelConfig
  /** True while the tyre is touching ground. */
  grounded: boolean
  /** Current suspension extension from the mount, in metres. */
  suspensionLength: number
  compression: number
  /** World-space contact point and surface normal. */
  contactX: number
  contactY: number
  contactZ: number
  normalX: number
  normalY: number
  normalZ: number
  /** Load through this tyre, in newtons — drives dust, sound and grip. */
  load: number
  steerAngle: number
  /** Spin angle for rendering, radians. */
  spin: number
  angularVelocity: number
  /** Longitudinal slip, roughly -1..1. */
  slipRatio: number
  /** Lateral slip angle in radians. */
  slipAngle: number
  /** How much mud is packed onto the tyre, 0..1. */
  dirt: number
  /** Depth of mud the tyre is currently sitting in, metres. */
  sinkDepth: number
}

const UP = { x: 0, y: 1, z: 0 }

export class Vehicle {
  readonly spec: VehicleSpec
  readonly body: RAPIER.RigidBody
  readonly wheels: WheelState[] = []

  private rapier: typeof RAPIER
  private terrain: Terrain
  private steerActual = 0
  private surfaceSample: SurfaceSample = { churn: 0, wetness: 0 }

  /** Scratch vectors, reused every step to keep the hot path allocation-free. */
  private tmpA = { x: 0, y: 0, z: 0 }
  private tmpB = { x: 0, y: 0, z: 0 }

  constructor(
    rapier: typeof RAPIER,
    world: RAPIER.World,
    terrain: Terrain,
    spec: VehicleSpec,
    spawn: { x: number; y: number; z: number },
    heading = 0,
  ) {
    this.rapier = rapier
    this.terrain = terrain
    this.spec = spec

    const bodyDesc = rapier.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setRotation(quaternionFromYaw(heading))
      // Without damping the chassis keeps a little residual spin after every
      // landing, which reads as the truck being "greasy".
      .setLinearDamping(0.06)
      .setAngularDamping(0.32)
      .setCcdEnabled(true)
    this.body = world.createRigidBody(bodyDesc)

    // Density zero: the collider contributes shape for contacts but no mass, so
    // the explicit mass properties below are the whole story. Leaving the
    // collider's own mass in would silently double the truck's weight and the
    // springs — sized from `spec.mass` — could never hold it up.
    const colliderDesc = rapier.ColliderDesc.cuboid(
      spec.bodyHalfWidth,
      spec.bodyHalfHeight,
      spec.bodyHalfLength,
    )
      .setDensity(0)
      .setFriction(0.4)
      .setRestitution(0.05)
    world.createCollider(colliderDesc, this.body)

    // Solid-cuboid inertia about each axis, then trimmed on yaw so the truck
    // rotates into a turn rather than ploughing straight on.
    const w = spec.bodyHalfWidth * 2
    const h = spec.bodyHalfHeight * 2
    const d = spec.bodyHalfLength * 2
    const k = spec.mass / 12
    // Drop the centre of mass below the collider centre: a pickup with its mass
    // at the geometric centre rolls over in any hard turn.
    this.body.setAdditionalMassProperties(
      spec.mass,
      { x: 0, y: spec.centreOfMassY, z: 0 },
      {
        x: k * (h * h + d * d),
        y: k * (w * w + d * d) * 0.82,
        z: k * (w * w + h * h) * 1.35,
      },
      { w: 1, x: 0, y: 0, z: 0 },
      true,
    )

    for (const config of spec.wheels) {
      this.wheels.push({
        config,
        grounded: false,
        suspensionLength: spec.suspensionRestLength,
        compression: 0,
        contactX: 0,
        contactY: 0,
        contactZ: 0,
        normalX: 0,
        normalY: 1,
        normalZ: 0,
        load: 0,
        steerAngle: 0,
        spin: 0,
        angularVelocity: 0,
        slipRatio: 0,
        slipAngle: 0,
        dirt: 0,
        sinkDepth: 0,
      })
    }
  }

  get speed(): number {
    const v = this.body.linvel()
    return Math.hypot(v.x, v.y, v.z)
  }

  /** Signed forward speed — negative when reversing. */
  get forwardSpeed(): number {
    const v = this.body.linvel()
    this.localAxis(0, 0, 1, this.tmpA)
    return v.x * this.tmpA.x + v.y * this.tmpA.y + v.z * this.tmpA.z
  }

  get speedKmh(): number {
    return this.speed * 3.6
  }

  /** True when no wheel can find ground — used to gate engine torque and to detect jumps. */
  get airborne(): boolean {
    return this.wheels.every((w) => !w.grounded)
  }

  update(dt: number, controls: VehicleControls): void {
    const spec = this.spec

    // Rapier treats forces added via addForce/addForceAtPoint as *persistent*:
    // they stay on the body across timesteps until explicitly cleared. Without
    // this reset every frame piles onto the last, and within a second or two
    // the accumulated suspension force launches the truck into the sky.
    this.body.resetForces(false)
    this.body.resetTorques(false)

    // Steering: ease toward the target and shrink the achievable angle with
    // speed, so a flick of the wheel at 40km/h does not spin the truck.
    const speed = Math.abs(this.forwardSpeed)
    const authority = 1 / (1 + speed * spec.steerSpeedFalloff)
    const targetSteer = clamp(controls.steer, -1, 1) * spec.maxSteerAngle * authority
    this.steerActual = damp(this.steerActual, targetSteer, 9, dt)

    const rotation = this.body.rotation()
    const linvel = this.body.linvel()
    const angvel = this.body.angvel()
    // Lever arms for v = linear + ω × r must be measured from the centre of
    // mass, which sits below the body origin here.
    const com = this.body.worldCom()

    let groundedCount = 0

    for (const wheel of this.wheels) {
      wheel.steerAngle = wheel.config.steered ? this.steerActual : 0

      // Mount point in world space.
      const origin = this.body.translation()
      rotateVector(rotation, wheel.config.x, wheel.config.y, wheel.config.z, this.tmpA)
      const mountX = origin.x + this.tmpA.x
      const mountY = origin.y + this.tmpA.y
      const mountZ = origin.z + this.tmpA.z

      // Suspension acts along the chassis' own down axis, not world down —
      // that is what keeps the wheels planted when the body is pitched.
      rotateVector(rotation, 0, -1, 0, this.tmpB)
      const downX = this.tmpB.x
      const downY = this.tmpB.y
      const downZ = this.tmpB.z

      const maxReach = spec.suspensionRestLength + spec.suspensionMaxTravel + wheel.config.radius
      const hit = this.probeGround(mountX, mountY, mountZ, downX, downY, downZ, maxReach)

      if (!hit) {
        wheel.grounded = false
        wheel.load = 0
        wheel.slipRatio = 0
        wheel.slipAngle = 0
        wheel.sinkDepth = 0
        // Droop back out to full extension rather than snapping.
        wheel.suspensionLength = damp(wheel.suspensionLength, spec.suspensionRestLength + spec.suspensionMaxTravel, 12, dt)
        // Free-spinning wheel slowly loses speed in the air.
        wheel.angularVelocity *= 1 - 0.7 * dt
        wheel.spin += wheel.angularVelocity * dt
        wheel.dirt = damp(wheel.dirt, wheel.dirt * 0.98, 1, dt)
        continue
      }

      groundedCount++
      wheel.grounded = true
      wheel.contactX = hit.x
      wheel.contactY = hit.y
      wheel.contactZ = hit.z
      wheel.normalX = hit.nx
      wheel.normalY = hit.ny
      wheel.normalZ = hit.nz

      const currentLength = clamp(
        hit.distance - wheel.config.radius,
        0,
        spec.suspensionRestLength + spec.suspensionMaxTravel,
      )
      wheel.suspensionLength = currentLength
      wheel.compression = clamp((spec.suspensionRestLength - currentLength) / spec.suspensionRestLength, -1, 1)

      // --- Suspension force -------------------------------------------------
      const springForce = spec.suspensionStiffness * (spec.suspensionRestLength - currentLength)

      // Compression rate comes from the chassis' actual velocity at the mount,
      // not from differencing the previous frame's length. Differencing spikes
      // on the first frame of contact — the wheel jumps from full droop to
      // loaded in one tick — and that spike is enough to launch the truck.
      const rmx = mountX - com.x
      const rmy = mountY - com.y
      const rmz = mountZ - com.z
      const vmx = linvel.x + (angvel.y * rmz - angvel.z * rmy)
      const vmy = linvel.y + (angvel.z * rmx - angvel.x * rmz)
      const vmz = linvel.z + (angvel.x * rmy - angvel.y * rmx)
      const compressionVelocity = vmx * downX + vmy * downY + vmz * downZ

      const damperForce = spec.suspensionDamping * compressionVelocity
      // Springs push, never pull.
      let suspensionForce = Math.max(0, springForce + damperForce)

      // Bump stop: going past max travel ramps force sharply so the axle does
      // not pass through the chassis on a hard landing.
      if (currentLength < spec.suspensionRestLength - spec.suspensionMaxTravel) {
        const overshoot = spec.suspensionRestLength - spec.suspensionMaxTravel - currentLength
        suspensionForce += overshoot * spec.suspensionStiffness * 8
      }

      // Backstop against a bad landing turning into a launch. Six times the
      // static corner load is far more than real suspension delivers, so this
      // never shapes normal driving — it only bounds the pathological case.
      const staticCornerLoad = (spec.mass * 9.81) / spec.wheels.length
      suspensionForce = Math.min(suspensionForce, staticCornerLoad * 6)

      wheel.load = suspensionForce

      // Applied along the surface normal, not straight up: on a slope this is
      // what makes the truck want to slide downhill.
      this.addForceAtPoint(
        hit.nx * suspensionForce,
        hit.ny * suspensionForce,
        hit.nz * suspensionForce,
        hit.x,
        hit.y,
        hit.z,
      )

      // --- Ground material --------------------------------------------------
      this.terrain.surfaceAt(hit.x, hit.z, this.surfaceSample)
      const churn = this.surfaceSample.churn
      const wetness = this.surfaceSample.wetness
      // Wet, churned mud is slick; packed dry ground bites.
      const gripScale = 1 - churn * 0.16 - wetness * 0.18
      const grip = spec.tyreGrip * clamp(gripScale, 0.32, 1)
      wheel.sinkDepth = churn * 0.09 + wetness * 0.03

      // Mud packs onto the tyre in the wet and is flung off on firm ground.
      const muddiness = clamp(churn * 0.6 + wetness, 0, 1)
      const dirtTarget = muddiness > 0.35 ? clamp(muddiness, 0, 1) : 0
      wheel.dirt = damp(wheel.dirt, dirtTarget, muddiness > 0.35 ? 2.4 : 0.55, dt)

      // --- Tyre frame -------------------------------------------------------
      // Forward direction, steered, then flattened onto the contact plane.
      const steerCos = Math.cos(wheel.steerAngle)
      const steerSin = Math.sin(wheel.steerAngle)
      rotateVector(rotation, steerSin, 0, steerCos, this.tmpA)
      let fwdX = this.tmpA.x
      let fwdY = this.tmpA.y
      let fwdZ = this.tmpA.z
      const fwdDotN = fwdX * hit.nx + fwdY * hit.ny + fwdZ * hit.nz
      fwdX -= hit.nx * fwdDotN
      fwdY -= hit.ny * fwdDotN
      fwdZ -= hit.nz * fwdDotN
      const fwdLen = Math.hypot(fwdX, fwdY, fwdZ) || 1
      fwdX /= fwdLen
      fwdY /= fwdLen
      fwdZ /= fwdLen

      // Lateral = normal × forward.
      const latX = hit.ny * fwdZ - hit.nz * fwdY
      const latY = hit.nz * fwdX - hit.nx * fwdZ
      const latZ = hit.nx * fwdY - hit.ny * fwdX

      // Contact-point velocity = linear + angular × r.
      const rx = hit.x - com.x
      const ry = hit.y - com.y
      const rz = hit.z - com.z
      const vx = linvel.x + (angvel.y * rz - angvel.z * ry)
      const vy = linvel.y + (angvel.z * rx - angvel.x * rz)
      const vz = linvel.z + (angvel.x * ry - angvel.y * rx)

      const vForward = vx * fwdX + vy * fwdY + vz * fwdZ
      const vLateral = vx * latX + vy * latY + vz * latZ

      // --- Longitudinal -----------------------------------------------------
      let driveForce = 0
      if (wheel.config.driven && controls.throttle > 0.01) {
        // Torque tapers to nothing at top speed instead of cutting out.
        const speedFactor = clamp(1 - Math.abs(vForward) / spec.topSpeed, 0, 1)
        driveForce = spec.enginePower * controls.throttle * speedFactor * (1 / this.drivenWheelCount())
      }

      let brakeForce = 0
      if (controls.brake > 0.01) {
        brakeForce += spec.brakeTorque * controls.brake * wheel.config.brakeBias
      }
      if (controls.handbrake && wheel.config.handbrake) {
        brakeForce += spec.handbrakeTorque
      }
      // Brakes oppose motion; at a standstill they hold rather than reverse.
      const brakeSign = vForward > 0.1 ? -1 : vForward < -0.1 ? 1 : 0
      const appliedBrake = brakeForce * brakeSign

      // Rolling resistance and mud drag — deep ruts genuinely slow the truck.
      const rolling = -Math.sign(vForward) * (spec.rollingResistance + churn * 180 + wheel.sinkDepth * 520)

      let longitudinal = driveForce + appliedBrake + rolling

      // --- Lateral ----------------------------------------------------------
      wheel.slipAngle = Math.atan2(vLateral, Math.abs(vForward) + 0.9)
      // Linear near zero, saturating past the peak — a cheap Pacejka stand-in.
      const lateralResponse = Math.sin(clamp(wheel.slipAngle * 2.6, -Math.PI / 2, Math.PI / 2))
      let lateral = -lateralResponse * wheel.load * grip

      // --- Friction circle --------------------------------------------------
      // The tyre has one budget shared between turning and driving; exceed it
      // and it breaks away, which is what lets the truck slide in the wet.
      const maxForce = wheel.load * grip
      const total = Math.hypot(longitudinal, lateral)
      if (total > maxForce && total > 1e-3) {
        const scale = maxForce / total
        longitudinal *= scale
        lateral *= scale
        wheel.slipRatio = clamp((total - maxForce) / maxForce, 0, 1) * Math.sign(driveForce || -vForward)
      } else {
        wheel.slipRatio = damp(wheel.slipRatio, 0, 6, dt)
      }

      this.addForceAtPoint(
        fwdX * longitudinal + latX * lateral,
        fwdY * longitudinal + latY * lateral,
        fwdZ * longitudinal + latZ * lateral,
        hit.x,
        hit.y,
        hit.z,
      )

      // Wheel spin for rendering: rolling speed, plus visible wheelspin.
      const rollingOmega = vForward / wheel.config.radius
      const spinBoost = wheel.config.driven ? wheel.slipRatio * 26 : 0
      wheel.angularVelocity = rollingOmega + spinBoost
      wheel.spin += wheel.angularVelocity * dt
    }

    // Aerodynamic drag and a little downforce, applied at the body centre.
    const v = this.body.linvel()
    const speedSq = v.x * v.x + v.y * v.y + v.z * v.z
    if (speedSq > 0.01) {
      const speedMag = Math.sqrt(speedSq)
      const drag = spec.dragCoefficient * speedSq
      this.body.addForce(
        { x: (-v.x / speedMag) * drag, y: (-v.y / speedMag) * drag, z: (-v.z / speedMag) * drag },
        true,
      )
    }
    if (groundedCount > 0) {
      this.body.addForce({ x: 0, y: -spec.downforce * speedSq * 0.02, z: 0 }, true)
    }
  }

  private drivenWheelCount(): number {
    let count = 0
    for (const wheel of this.wheels) if (wheel.config.driven) count++
    return count || 1
  }

  private addForceAtPoint(fx: number, fy: number, fz: number, px: number, py: number, pz: number): void {
    this.body.addForceAtPoint({ x: fx, y: fy, z: fz }, { x: px, y: py, z: pz }, true)
  }

  /**
   * Marches the suspension ray against the height field. A plain vertical
   * lookup is wrong once the chassis pitches, so the ray is stepped and then
   * refined where it first goes under the surface.
   */
  private probeGround(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
  ): { x: number; y: number; z: number; nx: number; ny: number; nz: number; distance: number } | null {
    const steps = 12
    let previousT = 0
    let previousGap = oy - this.terrain.heightAt(ox, oz)

    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * maxDistance
      const px = ox + dx * t
      const py = oy + dy * t
      const pz = oz + dz * t
      const gap = py - this.terrain.heightAt(px, pz)

      if (gap <= 0) {
        // Crossed the surface between previousT and t — refine by bisection.
        let lo = previousT
        let hi = t
        let loGap = previousGap
        for (let iter = 0; iter < 6; iter++) {
          const mid = (lo + hi) * 0.5
          const mx = ox + dx * mid
          const my = oy + dy * mid
          const mz = oz + dz * mid
          const midGap = my - this.terrain.heightAt(mx, mz)
          if (midGap <= 0) {
            hi = mid
          } else {
            lo = mid
            loGap = midGap
          }
        }
        void loGap
        const distance = hi
        const hx = ox + dx * distance
        const hz = oz + dz * distance
        const hy = this.terrain.heightAt(hx, hz)
        this.terrain.normalAt(hx, hz, this.tmpB)
        return {
          x: hx,
          y: hy,
          z: hz,
          nx: this.tmpB.x,
          ny: this.tmpB.y,
          nz: this.tmpB.z,
          distance,
        }
      }
      previousT = t
      previousGap = gap
    }
    return null
  }

  /** Chassis-local axis expressed in world space. */
  private localAxis(x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
    rotateVector(this.body.rotation(), x, y, z, out)
  }

  /** Puts the truck back on its wheels where it stands. */
  recover(): void {
    const t = this.body.translation()
    const groundY = this.terrain.heightAt(t.x, t.z)
    this.body.setTranslation({ x: t.x, y: groundY + 1.4, z: t.z }, true)
    const yaw = yawFromQuaternion(this.body.rotation())
    this.body.setRotation(quaternionFromYaw(yaw), true)
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
  }

  get rapierModule(): typeof RAPIER {
    return this.rapier
  }
}

export function rotateVector(
  q: { x: number; y: number; z: number; w: number },
  vx: number,
  vy: number,
  vz: number,
  out: { x: number; y: number; z: number },
): void {
  // v + 2q_v × (q_v × v + q_w v)
  const tx = 2 * (q.y * vz - q.z * vy)
  const ty = 2 * (q.z * vx - q.x * vz)
  const tz = 2 * (q.x * vy - q.y * vx)
  out.x = vx + q.w * tx + (q.y * tz - q.z * ty)
  out.y = vy + q.w * ty + (q.z * tx - q.x * tz)
  out.z = vz + q.w * tz + (q.x * ty - q.y * tx)
}

export function quaternionFromYaw(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }
}

export function yawFromQuaternion(q: { x: number; y: number; z: number; w: number }): number {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z))
}

export { UP }
