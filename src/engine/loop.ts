/**
 * Fixed-timestep loop. Simulation runs at a constant rate so ballistics and AI
 * behave identically on a 60Hz phone and a 120Hz one; rendering happens once
 * per animation frame with the leftover time passed along for interpolation.
 */

export const TICK_RATE = 60
export const TICK_DT = 1 / TICK_RATE

/** Never simulate more than this much wall time in one frame (tab was hidden). */
const MAX_FRAME_TIME = 0.25

export interface LoopHandlers {
  update: (dt: number) => void
  render: (alpha: number, frameDt: number) => void
}

export class Loop {
  private running = false
  private accumulator = 0
  private lastTime = 0
  private rafId = 0
  private handlers: LoopHandlers

  /** Rolling average frame time, exposed for the debug overlay. */
  fps = 0

  constructor(handlers: LoopHandlers) {
    this.handlers = handlers
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now()
    this.accumulator = 0
    this.rafId = requestAnimationFrame(this.frame)
  }

  stop(): void {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  private frame = (now: number): void => {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this.frame)

    let frameTime = (now - this.lastTime) / 1000
    this.lastTime = now
    if (frameTime > MAX_FRAME_TIME) frameTime = MAX_FRAME_TIME
    if (frameTime > 0) this.fps = this.fps === 0 ? 1 / frameTime : this.fps * 0.9 + (1 / frameTime) * 0.1

    this.accumulator += frameTime
    let steps = 0
    while (this.accumulator >= TICK_DT && steps < 5) {
      this.handlers.update(TICK_DT)
      this.accumulator -= TICK_DT
      steps++
    }
    // If we blew the step budget the device cannot keep up; drop the backlog
    // rather than spiralling further behind.
    if (steps >= 5) this.accumulator = 0

    this.handlers.render(this.accumulator / TICK_DT, frameTime)
  }
}
