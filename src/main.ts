import './ui/styles.css'
import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { Loop, TICK_DT } from './engine/loop'
import { clamp, damp } from './engine/math'
import { Terrain, TERRAIN_SIZE } from './world/terrain'
import { TerrainMesh } from './world/terrain-mesh'
import { createBoundaryWalls, createScene } from './world/scene'
import { PICKUP_SPEC, Vehicle, rotateVector } from './vehicle/vehicle'
import { buildTruck } from './vehicle/truck-mesh'
import { loadTruckModel } from './vehicle/truck-model'
import { createControls } from './ui/controls'
import { createHud } from './ui/hud'

/** Camera rigs, cycled with the on-screen button. */
const CAMERA_MODES = ['chase', 'close', 'bonnet'] as const
type CameraMode = (typeof CAMERA_MODES)[number]

const CAMERA_RIGS: Record<CameraMode, { back: number; height: number; lookAhead: number; fov: number }> = {
  chase: { back: 8.2, height: 3.4, lookAhead: 4.5, fov: 58 },
  close: { back: 5.6, height: 2.4, lookAhead: 3.5, fov: 62 },
  bonnet: { back: -0.6, height: 1.5, lookAhead: 8, fov: 68 },
}

async function boot(): Promise<void> {
  const app = document.querySelector<HTMLElement>('#app')!

  const loading = document.createElement('div')
  loading.className = 'loading'
  loading.innerHTML = `
    <div class="loading-title">جاري التحميل…</div>
    <div class="loading-bar"><i></i></div>
    <div class="loading-note">تجهيز الفيزياء والأرضية</div>
  `
  app.appendChild(loading)

  const canvas = document.createElement('canvas')
  canvas.id = 'view'
  app.appendChild(canvas)

  // Rapier ships as WebAssembly and must finish loading before any world exists.
  await RAPIER.init()

  const { renderer, scene, camera } = createScene(canvas)

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  // One physics step per simulation tick keeps Rapier and the vehicle in lockstep.
  world.timestep = TICK_DT

  const terrain = new Terrain()
  const terrainMesh = new TerrainMesh(terrain)
  scene.add(terrainMesh.mesh)

  // Rocks are deliberately absent: the arena is a clean mud field, and its
  // relief comes from the height field and the surface material instead.
  createBoundaryWalls(RAPIER, world)

  // Non-blocking: the ground draws untextured for the first frames rather than
  // holding the whole boot on a 6MB pair of 2048px maps.
  void terrainMesh
    .loadSurfaceDetail('./textures/ground-normal.png', './textures/ground-ao.png')
    .catch((error: unknown) => console.warn('surface detail unavailable:', error))

  // Spawn on the road, pointing along it.
  const spawnX = TERRAIN_SIZE * 0.5
  const spawnZ = TERRAIN_SIZE * 0.42
  const vehicle = new Vehicle(
    RAPIER,
    world,
    terrain,
    PICKUP_SPEC,
    { x: spawnX, y: terrain.heightAt(spawnX, spawnZ) + 1.3, z: spawnZ },
    0,
  )

  // Prefer the authored model; fall back to the parametric one so a missing or
  // broken asset degrades to a playable truck instead of a black screen.
  let truck
  try {
    truck = await loadTruckModel('./models/truck.glb', {
      // This asset is authored nose-toward -Z; the game drives toward +Z.
      headingOffset: Math.PI,
    })
    console.info(`model loaded: ${truck.triangleCount} triangles`)
  } catch (error) {
    console.warn('falling back to the parametric truck:', error)
    truck = buildTruck()
  }
  scene.add(truck.group)

  const controls = createControls(app)
  const hud = createHud(app)
  controls.onRecover(() => vehicle.recover())

  let cameraMode: CameraMode = 'chase'
  controls.onCameraToggle(() => {
    cameraMode = CAMERA_MODES[(CAMERA_MODES.indexOf(cameraMode) + 1) % CAMERA_MODES.length]!
  })

  // --- Resize ---------------------------------------------------------------
  const resize = (): void => {
    const width = window.innerWidth
    const height = window.innerHeight
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
  resize()
  window.addEventListener('resize', resize)
  window.addEventListener('orientationchange', () => setTimeout(resize, 120))

  // --- Reusable scratch objects --------------------------------------------
  const chassisPosition = new THREE.Vector3()
  const chassisQuaternion = new THREE.Quaternion()
  const cameraTarget = new THREE.Vector3()
  const cameraDesired = new THREE.Vector3()
  const lookTarget = new THREE.Vector3()
  const forwardWorld = { x: 0, y: 0, z: 0 }
  const upWorld = { x: 0, y: 0, z: 0 }

  let cameraInitialised = false
  let smoothedFov = CAMERA_RIGS.chase.fov

  const hudState = {
    speedKmh: 0,
    compression: [0, 0, 0, 0],
    dirt: [0, 0, 0, 0],
    grounded: [false, false, false, false],
    fps: 0,
  }

  // --- Simulation -----------------------------------------------------------
  const update = (dt: number): void => {
    const input = controls.read(dt)
    vehicle.update(dt, input)
    world.step()

    // Wheels cut into the mud wherever they are loaded. Deformation is driven
    // by load rather than by contact alone, so a lightly-touching wheel on a
    // crest leaves nothing while a laden one digs in.
    for (const wheel of vehicle.wheels) {
      if (!wheel.grounded) continue
      if (!terrain.isInside(wheel.contactX, wheel.contactZ, 0.5)) continue

      const loadFactor = clamp(wheel.load / (PICKUP_SPEC.mass * 9.81 * 0.4), 0, 1.6)
      // Spinning or sliding tyres tear the ground up far more than rolling ones.
      const slip = Math.min(1, Math.abs(wheel.slipRatio) + Math.abs(wheel.slipAngle) * 0.5)
      const depth = (0.0022 + slip * 0.011) * loadFactor * (dt / TICK_DT)
      terrain.deform(
        wheel.contactX,
        wheel.contactZ,
        wheel.config.width * 0.62,
        depth,
        // Churn accrues slowly on purpose. Saturating it in a few frames
        // created a trap: the first spin destroyed local grip, which caused
        // more spin, and the truck could never drive out of its own rut.
        (0.06 + slip * 0.22) * loadFactor * (dt / TICK_DT),
      )
    }
  }

  // --- Presentation ---------------------------------------------------------
  const render = (_alpha: number, frameDt: number): void => {
    const translation = vehicle.body.translation()
    const rotation = vehicle.body.rotation()
    chassisPosition.set(translation.x, translation.y, translation.z)
    chassisQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)

    truck.group.position.copy(chassisPosition)
    truck.group.quaternion.copy(chassisQuaternion)

    // Wheels: steer around the chassis up axis, spin around their own axle, and
    // ride up and down with their suspension.
    for (let i = 0; i < truck.wheelPivots.length; i++) {
      const pivot = truck.wheelPivots[i]!
      const wheel = vehicle.wheels[i]!
      // The mount is the fixed end; the wheel hangs below it by however far the
      // suspension is currently extended.
      pivot.position.set(wheel.config.x, wheel.config.y - wheel.suspensionLength, wheel.config.z)
      pivot.rotation.set(0, wheel.steerAngle, 0)
      pivot.children[0]!.rotation.x = wheel.spin

      hudState.compression[i] = wheel.compression
      hudState.dirt[i] = wheel.dirt
      hudState.grounded[i] = wheel.grounded
    }

    // --- Camera -------------------------------------------------------------
    rotateVector(rotation, 0, 0, 1, forwardWorld)
    rotateVector(rotation, 0, 1, 0, upWorld)
    const rig = CAMERA_RIGS[cameraMode]

    // Chase cameras follow the heading, not the full body orientation —
    // inheriting roll and pitch from the chassis is nauseating on a phone.
    const heading = Math.atan2(forwardWorld.x, forwardWorld.z)
    const flatForwardX = Math.sin(heading)
    const flatForwardZ = Math.cos(heading)

    if (cameraMode === 'bonnet') {
      // Bonnet view rides with the body, so it does inherit orientation.
      cameraDesired
        .set(0, rig.height, rig.back)
        .applyQuaternion(chassisQuaternion)
        .add(chassisPosition)
      lookTarget
        .set(0, rig.height * 0.82, rig.back + rig.lookAhead)
        .applyQuaternion(chassisQuaternion)
        .add(chassisPosition)
      camera.position.copy(cameraDesired)
      camera.up.set(upWorld.x, upWorld.y, upWorld.z)
    } else {
      cameraDesired.set(
        chassisPosition.x - flatForwardX * rig.back,
        chassisPosition.y + rig.height,
        chassisPosition.z - flatForwardZ * rig.back,
      )
      // Never let the camera sink into the ground on a slope.
      const groundY = terrain.heightAt(cameraDesired.x, cameraDesired.z)
      cameraDesired.y = Math.max(cameraDesired.y, groundY + 1.1)

      if (!cameraInitialised) {
        camera.position.copy(cameraDesired)
        cameraInitialised = true
      } else {
        // Frame-rate independent smoothing; looser vertically so bumps do not
        // throw the whole view around.
        camera.position.x = damp(camera.position.x, cameraDesired.x, 7.5, frameDt)
        camera.position.y = damp(camera.position.y, cameraDesired.y, 4.2, frameDt)
        camera.position.z = damp(camera.position.z, cameraDesired.z, 7.5, frameDt)
      }

      lookTarget.set(
        chassisPosition.x + flatForwardX * rig.lookAhead,
        chassisPosition.y + 0.9,
        chassisPosition.z + flatForwardZ * rig.lookAhead,
      )
      camera.up.set(0, 1, 0)
    }

    cameraTarget.copy(lookTarget)
    camera.lookAt(cameraTarget)

    // Widening the lens with speed sells acceleration more cheaply than any
    // post-process would.
    const speedFraction = clamp(vehicle.speed / PICKUP_SPEC.topSpeed, 0, 1)
    smoothedFov = damp(smoothedFov, rig.fov + speedFraction * 9, 3, frameDt)
    if (Math.abs(camera.fov - smoothedFov) > 0.01) {
      camera.fov = smoothedFov
      camera.updateProjectionMatrix()
    }

    terrainMesh.update(frameDt)

    controls.setWheelAngle(clamp(vehicle.wheels[0]!.steerAngle / PICKUP_SPEC.maxSteerAngle, -1, 1))
    hudState.speedKmh = Math.abs(vehicle.speedKmh)
    hudState.fps = loop.fps
    hud.update(hudState)

    renderer.render(scene, camera)
  }

  const loop = new Loop({ update, render })
  loop.start()

  requestAnimationFrame(() => loading.classList.add('hidden'))
  setTimeout(() => loading.remove(), 700)

  // Expose for console poking during development.
  Object.assign(window as unknown as Record<string, unknown>, { vehicle, terrain, scene, renderer })
}

boot().catch((error: unknown) => {
  console.error(error)
  const app = document.querySelector<HTMLElement>('#app')
  if (app) {
    app.innerHTML = `<div class="loading"><div class="loading-title">تعذّر تشغيل اللعبة</div>
      <div class="loading-note">${error instanceof Error ? error.message : String(error)}</div></div>`
  }
})
