import { clamp, damp } from '../engine/math'
import type { VehicleControls } from '../vehicle/vehicle'

/**
 * Touch driving controls: a steering wheel you turn with your thumb, and
 * separate throttle and brake pedals — the layout drivers already expect from
 * this genre.
 *
 * The wheel tracks the angle from its own centre to the finger rather than
 * raw horizontal travel, so a thumb arcing across it behaves like a real rim
 * instead of drifting out from under the touch.
 */

export interface ControlsHandle {
  read(dt: number): VehicleControls
  /** Reflects the achieved steering angle back onto the wheel graphic. */
  setWheelAngle(normalised: number): void
  element: HTMLElement
  onRecover: (callback: () => void) => void
  onCameraToggle: (callback: () => void) => void
}

/** How far the rim turns, lock to lock, in radians of on-screen rotation. */
const WHEEL_VISUAL_LOCK = Math.PI * 0.72

export function createControls(parent: HTMLElement): ControlsHandle {
  const root = document.createElement('div')
  root.className = 'controls'
  root.innerHTML = `
    <div class="wheel" id="wheel">
      <svg viewBox="0 0 200 200" class="wheel-svg" id="wheel-svg">
        <circle cx="100" cy="100" r="88" class="wheel-rim"/>
        <circle cx="100" cy="100" r="70" class="wheel-inner"/>
        <path d="M100 100 L100 30" class="wheel-spoke"/>
        <path d="M100 100 L38 140" class="wheel-spoke"/>
        <path d="M100 100 L162 140" class="wheel-spoke"/>
        <circle cx="100" cy="100" r="26" class="wheel-hub"/>
      </svg>
    </div>

    <div class="pedals">
      <button class="pedal pedal-brake" id="pedal-brake" aria-label="فرامل">
        <span class="pedal-grip"></span>
      </button>
      <button class="pedal pedal-gas" id="pedal-gas" aria-label="بنزين">
        <span class="pedal-grip"></span>
      </button>
    </div>

    <div class="side-buttons">
      <button class="round-button" id="btn-camera" aria-label="تبديل الكاميرا">⟳</button>
      <button class="round-button" id="btn-recover" aria-label="إعادة السيارة">⤒</button>
      <button class="round-button handbrake" id="btn-handbrake" aria-label="فرامل اليد">P</button>
    </div>
  `
  parent.appendChild(root)

  const wheel = root.querySelector<HTMLElement>('#wheel')!
  const wheelSvg = root.querySelector<HTMLElement>('#wheel-svg')!
  const gasPedal = root.querySelector<HTMLElement>('#pedal-gas')!
  const brakePedal = root.querySelector<HTMLElement>('#pedal-brake')!
  const handbrakeButton = root.querySelector<HTMLElement>('#btn-handbrake')!
  const recoverButton = root.querySelector<HTMLElement>('#btn-recover')!
  const cameraButton = root.querySelector<HTMLElement>('#btn-camera')!

  let steerTarget = 0
  let steerSmoothed = 0
  let throttle = 0
  let brake = 0
  let handbrake = false

  let wheelPointerId: number | null = null
  let grabAngle = 0
  let grabSteer = 0

  const keys = new Set<string>()

  // --- Steering wheel -------------------------------------------------------
  const angleToFinger = (clientX: number, clientY: number): number => {
    const rect = wheel.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    return Math.atan2(clientX - cx, -(clientY - cy))
  }

  wheel.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    wheelPointerId = e.pointerId
    wheel.setPointerCapture(e.pointerId)
    grabAngle = angleToFinger(e.clientX, e.clientY)
    grabSteer = steerTarget
    wheel.classList.add('active')
  })

  wheel.addEventListener('pointermove', (e) => {
    if (wheelPointerId !== e.pointerId) return
    e.preventDefault()
    const delta = shortestAngle(angleToFinger(e.clientX, e.clientY) - grabAngle)
    steerTarget = clamp(grabSteer + delta / WHEEL_VISUAL_LOCK, -1, 1)
  })

  const releaseWheel = (e: PointerEvent): void => {
    if (wheelPointerId !== e.pointerId) return
    wheelPointerId = null
    wheel.classList.remove('active')
  }
  wheel.addEventListener('pointerup', releaseWheel)
  wheel.addEventListener('pointercancel', releaseWheel)

  // --- Pedals ---------------------------------------------------------------
  const bindPedal = (element: HTMLElement, onChange: (pressed: boolean) => void): void => {
    const press = (e: PointerEvent): void => {
      e.preventDefault()
      element.setPointerCapture(e.pointerId)
      element.classList.add('active')
      onChange(true)
    }
    const release = (e: PointerEvent): void => {
      e.preventDefault()
      element.classList.remove('active')
      onChange(false)
    }
    element.addEventListener('pointerdown', press)
    element.addEventListener('pointerup', release)
    element.addEventListener('pointercancel', release)
    element.addEventListener('pointerleave', release)
  }

  let gasHeld = false
  let brakeHeld = false
  bindPedal(gasPedal, (pressed) => (gasHeld = pressed))
  bindPedal(brakePedal, (pressed) => (brakeHeld = pressed))
  bindPedal(handbrakeButton, (pressed) => (handbrake = pressed))

  // --- Buttons --------------------------------------------------------------
  let recoverCallback: (() => void) | null = null
  let cameraCallback: (() => void) | null = null
  recoverButton.addEventListener('click', () => recoverCallback?.())
  cameraButton.addEventListener('click', () => cameraCallback?.())

  // --- Keyboard (desktop testing) ------------------------------------------
  window.addEventListener('keydown', (e) => {
    keys.add(e.code)
    if (e.code === 'KeyT') recoverCallback?.()
    if (e.code === 'KeyC') cameraCallback?.()
  })
  window.addEventListener('keyup', (e) => keys.delete(e.code))
  window.addEventListener('blur', () => {
    keys.clear()
    gasHeld = false
    brakeHeld = false
    handbrake = false
  })

  return {
    element: root,

    read(dt: number): VehicleControls {
      const keyLeft = keys.has('KeyA') || keys.has('ArrowLeft')
      const keyRight = keys.has('KeyD') || keys.has('ArrowRight')
      const keyGas = keys.has('KeyW') || keys.has('ArrowUp')
      const keyBrake = keys.has('KeyS') || keys.has('ArrowDown')
      const keyHandbrake = keys.has('Space')

      // Keyboard steering ramps in and self-centres; the wheel holds its angle.
      if (wheelPointerId === null && (keyLeft || keyRight)) {
        steerTarget = clamp(steerTarget + (keyRight ? 1 : -1) * dt * 2.6, -1, 1)
      } else if (wheelPointerId === null && !keyLeft && !keyRight) {
        steerTarget = damp(steerTarget, 0, 7, dt)
      }

      // Pedals ramp rather than switch, so a tap is not full throttle.
      throttle = damp(throttle, gasHeld || keyGas ? 1 : 0, 9, dt)
      brake = damp(brake, brakeHeld || keyBrake ? 1 : 0, 13, dt)
      steerSmoothed = damp(steerSmoothed, steerTarget, 14, dt)

      return {
        steer: steerSmoothed,
        throttle,
        brake,
        handbrake: handbrake || keyHandbrake,
      }
    },

    setWheelAngle(normalised: number): void {
      wheelSvg.style.transform = `rotate(${normalised * WHEEL_VISUAL_LOCK}rad)`
    },

    onRecover(callback: () => void): void {
      recoverCallback = callback
    },

    onCameraToggle(callback: () => void): void {
      cameraCallback = callback
    },
  }
}

function shortestAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}
