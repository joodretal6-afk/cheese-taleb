import { clamp, TAU } from './math'

/**
 * Touch-first input: two virtual sticks that materialise wherever the thumb
 * lands inside their half of the screen, plus a keyboard/mouse fallback so the
 * game is playable on desktop during development.
 */

export interface StickState {
  /** True while a finger owns this stick. */
  active: boolean
  /** Normalised deflection, magnitude 0..1. */
  x: number
  y: number
  magnitude: number
  angle: number
  /** Screen-space origin and current position, for drawing. */
  originX: number
  originY: number
  knobX: number
  knobY: number
}

const emptyStick = (): StickState => ({
  active: false,
  x: 0,
  y: 0,
  magnitude: 0,
  angle: 0,
  originX: 0,
  originY: 0,
  knobX: 0,
  knobY: 0,
})

export const STICK_RADIUS = 62
export const STICK_DEADZONE = 0.14

export type ButtonId = 'reload' | 'interact' | 'heal' | 'swap' | 'fire'

/** A screen-space circular button registered by the HUD each frame. */
export interface TouchButton {
  id: ButtonId
  x: number
  y: number
  radius: number
  enabled: boolean
}

interface PointerRecord {
  id: number
  role: 'move' | 'aim' | 'button' | 'tap'
  buttonId?: ButtonId
  startX: number
  startY: number
  x: number
  y: number
  startedAt: number
}

export class Input {
  readonly move: StickState = emptyStick()
  readonly aim: StickState = emptyStick()

  /** Buttons currently held, by id. */
  private held = new Set<ButtonId>()
  /** Buttons pressed since the last `endFrame()`. */
  private pressed = new Set<ButtonId>()

  private pointers = new Map<number, PointerRecord>()
  private buttons: TouchButton[] = []
  private keys = new Set<string>()

  /** Screen-space taps that were not consumed by a stick or button. */
  private taps: { x: number; y: number }[] = []

  private canvas: HTMLCanvasElement
  private width = 1
  private height = 1
  private usingTouch = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    canvas.addEventListener('pointerdown', this.onDown, { passive: false })
    canvas.addEventListener('pointermove', this.onMove, { passive: false })
    canvas.addEventListener('pointerup', this.onUp, { passive: false })
    canvas.addEventListener('pointercancel', this.onUp, { passive: false })
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.releaseAll)
  }

  get isTouch(): boolean {
    return this.usingTouch
  }

  setViewport(width: number, height: number): void {
    this.width = width
    this.height = height
  }

  /** The HUD re-declares its buttons every frame; layout may change with orientation. */
  setButtons(buttons: TouchButton[]): void {
    this.buttons = buttons
  }

  isHeld(id: ButtonId): boolean {
    return this.held.has(id)
  }

  wasPressed(id: ButtonId): boolean {
    return this.pressed.has(id)
  }

  consumeTaps(): { x: number; y: number }[] {
    const taps = this.taps
    this.taps = []
    return taps
  }

  /** Clears one-shot state. Call once per frame, after all systems have read input. */
  endFrame(): void {
    this.pressed.clear()
    this.syncKeyboard()
  }

  releaseAll = (): void => {
    this.pointers.clear()
    this.held.clear()
    this.keys.clear()
    resetStick(this.move)
    resetStick(this.aim)
  }

  private localPos(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  private hitButton(x: number, y: number): TouchButton | null {
    // Iterate in reverse so buttons declared later (drawn on top) win.
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const b = this.buttons[i]!
      if (!b.enabled) continue
      const dx = x - b.x
      const dy = y - b.y
      // Generous hit slop: fingers are imprecise and the cost of a miss is high.
      const r = b.radius * 1.25
      if (dx * dx + dy * dy <= r * r) return b
    }
    return null
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault()
    if (e.pointerType === 'touch') this.usingTouch = true
    const { x, y } = this.localPos(e)
    this.canvas.setPointerCapture?.(e.pointerId)

    const button = this.hitButton(x, y)
    if (button) {
      this.pointers.set(e.pointerId, {
        id: e.pointerId,
        role: 'button',
        buttonId: button.id,
        startX: x,
        startY: y,
        x,
        y,
        startedAt: performance.now(),
      })
      this.held.add(button.id)
      this.pressed.add(button.id)
      return
    }

    // Sticks own their half of the screen. RTL layout is irrelevant here: the
    // movement thumb is always the one nearer the left edge.
    const isLeftHalf = x < this.width * 0.5
    const stick = isLeftHalf ? this.move : this.aim
    if (!stick.active) {
      stick.active = true
      stick.originX = x
      stick.originY = y
      stick.knobX = x
      stick.knobY = y
      stick.x = 0
      stick.y = 0
      stick.magnitude = 0
      this.pointers.set(e.pointerId, {
        id: e.pointerId,
        role: isLeftHalf ? 'move' : 'aim',
        startX: x,
        startY: y,
        x,
        y,
        startedAt: performance.now(),
      })
      return
    }

    this.pointers.set(e.pointerId, {
      id: e.pointerId,
      role: 'tap',
      startX: x,
      startY: y,
      x,
      y,
      startedAt: performance.now(),
    })
  }

  private onMove = (e: PointerEvent): void => {
    const record = this.pointers.get(e.pointerId)
    if (!record) return
    e.preventDefault()
    const { x, y } = this.localPos(e)
    record.x = x
    record.y = y
    if (record.role === 'move') this.updateStick(this.move, x, y)
    else if (record.role === 'aim') this.updateStick(this.aim, x, y)
  }

  private onUp = (e: PointerEvent): void => {
    const record = this.pointers.get(e.pointerId)
    if (!record) return
    e.preventDefault()
    this.pointers.delete(e.pointerId)
    this.canvas.releasePointerCapture?.(e.pointerId)

    if (record.role === 'move') resetStick(this.move)
    else if (record.role === 'aim') resetStick(this.aim)
    else if (record.role === 'button' && record.buttonId) this.held.delete(record.buttonId)
    else if (record.role === 'tap') {
      const travel = Math.hypot(record.x - record.startX, record.y - record.startY)
      const duration = performance.now() - record.startedAt
      if (travel < 18 && duration < 400) this.taps.push({ x: record.x, y: record.y })
    }
  }

  private updateStick(stick: StickState, x: number, y: number): void {
    const dx = x - stick.originX
    const dy = y - stick.originY
    const len = Math.hypot(dx, dy)
    if (len < 1e-4) {
      stick.x = 0
      stick.y = 0
      stick.magnitude = 0
      stick.knobX = stick.originX
      stick.knobY = stick.originY
      return
    }
    const clamped = Math.min(len, STICK_RADIUS)
    const nx = dx / len
    const ny = dy / len
    stick.knobX = stick.originX + nx * clamped
    stick.knobY = stick.originY + ny * clamped
    const raw = clamped / STICK_RADIUS
    // Rescale past the deadzone so small deflections do not creep.
    const mag = raw < STICK_DEADZONE ? 0 : (raw - STICK_DEADZONE) / (1 - STICK_DEADZONE)
    stick.magnitude = mag
    stick.angle = Math.atan2(ny, nx)
    stick.x = nx * mag
    stick.y = ny * mag
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return
    this.keys.add(e.code)
    const button = keyToButton(e.code)
    if (button) {
      this.held.add(button)
      this.pressed.add(button)
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code)
    const button = keyToButton(e.code)
    if (button) this.held.delete(button)
  }

  /**
   * Folds WASD into the movement stick so the game can be driven from a laptop.
   * Aiming on desktop is handled by the renderer, which points the player at the
   * mouse cursor; this only covers movement.
   */
  private syncKeyboard(): void {
    if (this.move.active) return
    let x = 0
    let y = 0
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y -= 1
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y += 1
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1
    const len = Math.hypot(x, y)
    if (len === 0) {
      this.move.x = 0
      this.move.y = 0
      this.move.magnitude = 0
      return
    }
    this.move.x = x / len
    this.move.y = y / len
    this.move.magnitude = 1
    this.move.angle = Math.atan2(y, x)
  }
}

function resetStick(stick: StickState): void {
  stick.active = false
  stick.x = 0
  stick.y = 0
  stick.magnitude = 0
  stick.knobX = stick.originX
  stick.knobY = stick.originY
}

function keyToButton(code: string): ButtonId | null {
  switch (code) {
    case 'KeyR':
      return 'reload'
    case 'KeyE':
      return 'interact'
    case 'KeyQ':
      return 'swap'
    case 'KeyF':
      return 'heal'
    case 'Space':
      return 'fire'
    default:
      return null
  }
}

/** Normalises an angle into [0, TAU). */
export const normalizeAngle = (a: number): number => ((a % TAU) + TAU) % TAU

export const stickDeflection = (stick: StickState): number => clamp(stick.magnitude, 0, 1)
