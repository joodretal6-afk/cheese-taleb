import { Vector3, type Scene } from '@babylonjs/core'

/**
 * A free editor camera you fly while building the world.
 *
 * Move with WASD, rise/fall with E/Q (Space/Shift also work), hold **Shift**
 * to sprint, and look by dragging with a configurable mouse button — the right
 * button by default, so the left button stays free for a drawing tool. That is
 * the whole point: with the look button on the right, you can fly to any angle
 * (top, underneath, wherever) and keep left-clicking to lay down waypoints in
 * the same motion.
 *
 * It owns the camera the same way the camera dev-tools do: Sim.tick() re-runs
 * the chase rig every frame before rendering, so a one-shot camera move is wiped
 * next frame. Instead this drives the camera from scene.onBeforeRenderObservable
 * — which fires inside scene.render(), after the chase update — so while it is
 * enabled it fully owns the view, and disabling it hands control straight back.
 *
 * It only touches the camera; pausing physics (so WASD doesn't also drive the
 * truck) is the caller's job, since that lives in the store.
 */

interface FlyState {
  pos: Vector3
  yaw: number // 0 = +Z, matching the chase rig's convention
  pitch: number // -PI/2 looks straight down
  keys: Set<string>
  dragging: boolean
  lastX: number
  lastY: number
}

const PITCH_LIMIT = Math.PI / 2 - 0.02

export class EditorCamera {
  private readonly scene: Scene
  private enabled = false
  private lookButton = 2 // right mouse button
  private speed = 24
  private sprintMul = 3

  private readonly f: FlyState = {
    pos: new Vector3(0, 12, -20),
    yaw: 0,
    pitch: 0,
    keys: new Set<string>(),
    dragging: false,
    lastX: 0,
    lastY: 0,
  }

  private observer: unknown = null
  private canvas: HTMLCanvasElement | null = null
  private teardown: (() => void) | null = null

  constructor(scene: Scene) {
    this.scene = scene
  }

  get active(): boolean {
    return this.enabled
  }

  setSpeed(mps: number): void {
    this.speed = Math.max(1, mps)
  }

  getSpeed(): number {
    return this.speed
  }

  /**
   * Take over the camera. `lookButton` picks which mouse button rotates the
   * view (0 = left, 2 = right); default right, leaving the left button for
   * whatever tool is drawing.
   */
  enable(opts?: { lookButton?: 0 | 1 | 2 }): void {
    if (this.enabled) {
      if (opts?.lookButton !== undefined) this.lookButton = opts.lookButton
      return
    }
    const engine = this.scene.getEngine()
    const cam = this.scene.activeCamera
    if (!cam) return
    if (opts?.lookButton !== undefined) this.lookButton = opts.lookButton

    this.canvas = engine.getRenderingCanvas?.() ?? null

    // Seed the fly pose from the camera's current pose so the view doesn't jump.
    const f = this.f
    f.pos.copyFrom(cam.position)
    const fwd =
      typeof (cam as { getForwardRay?: () => { direction: Vector3 } }).getForwardRay === 'function'
        ? (cam as { getForwardRay: () => { direction: Vector3 } }).getForwardRay().direction
        : new Vector3(0, 0, 1)
    f.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.asin(fwd.y || 0)))
    f.yaw = Math.atan2(fwd.x, fwd.z)
    f.keys.clear()
    f.dragging = false

    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      f.keys.add(e.code)
    }
    const onKeyUp = (e: KeyboardEvent) => f.keys.delete(e.code)
    const onDown = (e: PointerEvent) => {
      if (e.button !== this.lookButton) return
      f.dragging = true
      f.lastX = e.clientX
      f.lastY = e.clientY
    }
    const onUp = (e: PointerEvent) => {
      if (e.button === this.lookButton) f.dragging = false
    }
    const onMove = (e: PointerEvent) => {
      if (!f.dragging) return
      const dx = e.clientX - f.lastX
      const dy = e.clientY - f.lastY
      f.lastX = e.clientX
      f.lastY = e.clientY
      const sens = 0.0045
      f.yaw += dx * sens
      f.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, f.pitch - dy * sens))
    }
    // Right-drag would otherwise pop the browser context menu over the canvas.
    const onContext = (e: Event) => {
      if (this.lookButton === 2) e.preventDefault()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    this.canvas?.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointermove', onMove)
    this.canvas?.addEventListener('contextmenu', onContext)

    const obs = this.scene.onBeforeRenderObservable.add(() => {
      const c = this.scene.activeCamera
      if (!c) return
      const dt = Math.min(0.05, engine.getDeltaTime() / 1000)
      const cp = Math.cos(f.pitch)
      const forward = new Vector3(Math.sin(f.yaw) * cp, Math.sin(f.pitch), Math.cos(f.yaw) * cp)
      const right = new Vector3(Math.cos(f.yaw), 0, -Math.sin(f.yaw))
      const boost = f.keys.has('ShiftLeft') || f.keys.has('ShiftRight') ? this.sprintMul : 1
      const step = this.speed * boost * dt
      const move = (v: Vector3, k: number) => f.pos.addInPlace(v.scale(k))
      if (f.keys.has('KeyW') || f.keys.has('ArrowUp')) move(forward, step)
      if (f.keys.has('KeyS') || f.keys.has('ArrowDown')) move(forward, -step)
      if (f.keys.has('KeyD') || f.keys.has('ArrowRight')) move(right, step)
      if (f.keys.has('KeyA') || f.keys.has('ArrowLeft')) move(right, -step)
      if (f.keys.has('KeyE') || f.keys.has('Space')) move(Vector3.Up(), step)
      if (f.keys.has('KeyQ')) move(Vector3.Up(), -step)

      // Run after the chase rig each frame, so this overwrite wins.
      c.position.copyFrom(f.pos)
      ;(c as unknown as { setTarget: (t: Vector3) => void }).setTarget(f.pos.add(forward))
    })
    this.observer = obs

    this.teardown = () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      this.canvas?.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointermove', onMove)
      this.canvas?.removeEventListener('contextmenu', onContext)
    }
    this.enabled = true
  }

  /** Hand the camera back to the chase rig. */
  disable(): void {
    if (!this.enabled) return
    this.teardown?.()
    this.teardown = null
    if (this.observer) {
      this.scene.onBeforeRenderObservable.remove(this.observer as never)
      this.observer = null
    }
    this.f.keys.clear()
    this.f.dragging = false
    this.enabled = false
  }

  dispose(): void {
    this.disable()
  }
}
