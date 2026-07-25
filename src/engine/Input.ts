/** Keyboard + gamepad input, normalised to -1..1 / 0..1 axes. */
export class Input {
  // --- driving ---
  throttle = 0
  brake = 0
  steer = 0
  handbrake = false

  // --- on foot --- (raw axes, resolved against the camera by the character)
  moveForward = 0
  moveRight = 0
  running = false
  /** True for the frame the jump key went down. */
  jump = false

  /** Edge-triggered actions consumed by the sim once per press. */
  private pressed = new Set<string>()
  private held = new Set<string>()
  private edges = new Set<string>()

  private onKeyDown = (e: KeyboardEvent) => {
    const k = e.code
    if (RELEVANT.has(k)) {
      e.preventDefault()
      if (!this.held.has(k)) this.edges.add(k)
      this.held.add(k)
      this.pressed.add(k)
    }
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.held.delete(e.code)
    this.pressed.delete(e.code)
  }

  private onBlur = () => {
    this.held.clear()
    this.pressed.clear()
  }

  attach(target: HTMLElement | Window = window) {
    target.addEventListener('keydown', this.onKeyDown as EventListener)
    target.addEventListener('keyup', this.onKeyUp as EventListener)
    window.addEventListener('blur', this.onBlur)
  }

  detach(target: HTMLElement | Window = window) {
    target.removeEventListener('keydown', this.onKeyDown as EventListener)
    target.removeEventListener('keyup', this.onKeyUp as EventListener)
    window.removeEventListener('blur', this.onBlur)
  }

  /** True once, on the frame the key went down. */
  consumePress(code: string): boolean {
    if (this.edges.has(code)) {
      this.edges.delete(code)
      return true
    }
    return false
  }

  update(dt: number) {
    const fwd = this.held.has('KeyW') || this.held.has('ArrowUp')
    const back = this.held.has('KeyS') || this.held.has('ArrowDown')
    const left = this.held.has('KeyA') || this.held.has('ArrowLeft')
    const right = this.held.has('KeyD') || this.held.has('ArrowRight')
    this.handbrake = this.held.has('Space')

    // Steering eases in and self-centres, so keyboard input isn't a step function.
    const steerTarget = (left ? -1 : 0) + (right ? 1 : 0)
    const rate = steerTarget === 0 ? 5.5 : 3.2
    this.steer += (steerTarget - this.steer) * Math.min(1, rate * dt)

    this.throttle = fwd ? 1 : 0
    this.brake = back ? 1 : 0

    // On foot the same keys are raw movement axes rather than pedals.
    this.moveForward = (fwd ? 1 : 0) - (back ? 1 : 0)
    this.moveRight = (right ? 1 : 0) - (left ? 1 : 0)
    this.running = this.held.has('ShiftLeft') || this.held.has('ShiftRight')
    this.jump = this.consumePress('Space')

    const pads = navigator.getGamepads?.() ?? []
    for (const pad of pads) {
      if (!pad) continue
      const ax = pad.axes[0] ?? 0
      const ay = pad.axes[1] ?? 0
      if (Math.abs(ax) > 0.12) {
        this.steer = ax
        this.moveRight = ax
      }
      if (Math.abs(ay) > 0.12) this.moveForward = -ay
      this.throttle = Math.max(this.throttle, pad.buttons[7]?.value ?? 0)
      this.brake = Math.max(this.brake, pad.buttons[6]?.value ?? 0)
      this.handbrake = this.handbrake || !!pad.buttons[0]?.pressed
      this.running = this.running || !!pad.buttons[10]?.pressed
      break
    }
  }
}

const RELEVANT = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'KeyR', 'KeyC', 'KeyF', 'KeyH',
  'ShiftLeft', 'ShiftRight',
])
