import { clamp, damp, type Vec2 } from './math'

/**
 * Follows a target in world space (metres) and converts between world and
 * screen coordinates. The camera sizes itself so that a fixed number of metres
 * is always visible across the *shorter* screen axis, which keeps the tactical
 * view identical on a tall phone and a wide tablet.
 */
export class Camera {
  x = 0
  y = 0
  /** Pixels per metre. */
  scale = 12

  private shakeAmount = 0
  private shakeX = 0
  private shakeY = 0

  private viewWidth = 1
  private viewHeight = 1
  private metresAcrossShortAxis = 46

  setViewport(width: number, height: number): void {
    this.viewWidth = width
    this.viewHeight = height
    this.recomputeScale()
  }

  setZoom(metresAcrossShortAxis: number): void {
    this.metresAcrossShortAxis = metresAcrossShortAxis
    this.recomputeScale()
  }

  private recomputeScale(): void {
    const shortAxis = Math.min(this.viewWidth, this.viewHeight)
    this.scale = shortAxis / this.metresAcrossShortAxis
  }

  snapTo(target: Vec2): void {
    this.x = target.x
    this.y = target.y
  }

  /**
   * `lead` nudges the view in the aim direction so the player sees more of the
   * space they are covering. It is deliberately small — a large lead makes the
   * player's own position feel unstable on a phone.
   */
  follow(target: Vec2, dt: number, lead: Vec2 = { x: 0, y: 0 }): void {
    const desiredX = target.x + lead.x
    const desiredY = target.y + lead.y
    this.x = damp(this.x, desiredX, 9, dt)
    this.y = damp(this.y, desiredY, 9, dt)

    if (this.shakeAmount > 0) {
      this.shakeAmount = Math.max(0, this.shakeAmount - dt * 26)
      const a = Math.random() * Math.PI * 2
      this.shakeX = Math.cos(a) * this.shakeAmount
      this.shakeY = Math.sin(a) * this.shakeAmount
    } else {
      this.shakeX = 0
      this.shakeY = 0
    }
  }

  addShake(amount: number): void {
    this.shakeAmount = clamp(this.shakeAmount + amount, 0, 14)
  }

  worldToScreenX(wx: number): number {
    return (wx - this.x) * this.scale + this.viewWidth * 0.5 + this.shakeX
  }

  worldToScreenY(wy: number): number {
    return (wy - this.y) * this.scale + this.viewHeight * 0.5 + this.shakeY
  }

  screenToWorldX(sx: number): number {
    return (sx - this.viewWidth * 0.5 - this.shakeX) / this.scale + this.x
  }

  screenToWorldY(sy: number): number {
    return (sy - this.viewHeight * 0.5 - this.shakeY) / this.scale + this.y
  }

  /** World-space rectangle currently visible, padded by `margin` metres. */
  viewBounds(margin = 4): { minX: number; minY: number; maxX: number; maxY: number } {
    const halfW = this.viewWidth * 0.5 / this.scale + margin
    const halfH = this.viewHeight * 0.5 / this.scale + margin
    return {
      minX: this.x - halfW,
      minY: this.y - halfH,
      maxX: this.x + halfW,
      maxY: this.y + halfH,
    }
  }

  /** Applies the world transform to a context; pairs with ctx.restore(). */
  applyTransform(ctx: CanvasRenderingContext2D): void {
    ctx.save()
    ctx.translate(this.viewWidth * 0.5 + this.shakeX, this.viewHeight * 0.5 + this.shakeY)
    ctx.scale(this.scale, this.scale)
    ctx.translate(-this.x, -this.y)
  }
}
