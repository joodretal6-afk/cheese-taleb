import { fbm, ridged } from './noise'

/**
 * The deformable mud layer.
 *
 * Two coupled fields sampled by BOTH the renderer and the vehicle physics, so a
 * rut you carve is a rut you then have to climb out of:
 *
 *   surfaceY(x,z) = baseHeight(x,z) - depth(x,z) + ridge(x,z)
 *
 *   depth — how far the soil has been compressed/displaced downwards (m)
 *   ridge — the material pushed sideways out of the rut, piled at its edges (m)
 *
 * Data lives in one RGBA8 texture the GPU reads for displacement and shading:
 *   R = depth / MAX_DEPTH
 *   G = ridge / MAX_RIDGE
 *   B = disturbance (how churned/wet-looking the surface is, decays slowly)
 *   A = tread imprint (the lug pattern stamped by the tyre)
 *
 * Uploads are tracked with a dirty rectangle so only the touched region is sent
 * to the GPU each frame, not the whole 1024² buffer.
 */

export const MAX_DEPTH = 0.55
export const MAX_RIDGE = 0.22

export interface MudFieldOptions {
  /** World size of the square play area, metres. */
  worldSize: number
  /** Texels per side. 1024 over 220 m ≈ 21 cm per texel. */
  resolution: number
  seed: number
}

export class MudField {
  readonly worldSize: number
  readonly res: number
  readonly seed: number
  /** Metres per texel. */
  readonly texel: number

  readonly depth: Float32Array
  readonly ridge: Float32Array
  readonly disturb: Float32Array
  readonly tread: Float32Array

  /** Interleaved RGBA8 mirror uploaded to the GPU. */
  readonly pixels: Uint8Array

  /** Static landscape height, precomputed once at texel resolution. */
  private readonly base: Float32Array

  /** Dirty rect in texel coords; x0 > x1 means "nothing dirty". */
  private dx0 = 1
  private dx1 = 0
  private dy0 = 1
  private dy1 = 0

  constructor(opts: MudFieldOptions) {
    this.worldSize = opts.worldSize
    this.res = opts.resolution
    this.seed = opts.seed
    this.texel = opts.worldSize / opts.resolution

    const n = this.res * this.res
    this.depth = new Float32Array(n)
    this.ridge = new Float32Array(n)
    this.disturb = new Float32Array(n)
    this.tread = new Float32Array(n)
    this.pixels = new Uint8Array(n * 4)
    this.base = new Float32Array(n)

    this.bakeBase()
    this.markAll()
    this.flushPixels()
  }

  // ---------------------------------------------------------------- landscape

  /**
   * X coordinate of the valley floor at a given Z. The track meanders, so
   * spawn points and prop scattering both need to ask where it actually is
   * rather than assuming x = 0.
   */
  trackCenterX(wz: number): number {
    return Math.sin(wz * 0.012) * 16 + Math.sin(wz * 0.0037 + 1.7) * 26
  }

  /**
   * Landscape shape: a broad valley floor the truck drives along, rocky ridges
   * either side, and a churned central track that already sits slightly lower.
   */
  private heightAt(wx: number, wz: number): number {
    const s = this.seed
    // Large rolling shape.
    let h = (fbm(wx * 0.0065, wz * 0.0065, 5, 2.03, 0.5, s) - 0.5) * 46

    // Valley: carve a corridor along +Z so there is an obvious drivable route.
    const meander = this.trackCenterX(wz)
    const distFromTrack = Math.abs(wx - meander)
    const valley = 1 - Math.exp(-Math.pow(distFromTrack / 26, 2))
    h -= (1 - valley) * 9

    // Rocky crests on the valley walls, faded out over the floor.
    const rock = ridged(wx * 0.021, wz * 0.021, 4, s + 31)
    h += rock * 13 * Math.pow(valley, 1.6)

    // Medium bumps and small surface detail.
    h += (fbm(wx * 0.055, wz * 0.055, 4, 2.11, 0.5, s + 77) - 0.5) * 2.6
    h += (fbm(wx * 0.19, wz * 0.19, 3, 2.03, 0.5, s + 211) - 0.5) * 0.55

    // The existing rutted track down the middle of the valley.
    const trackMask = Math.exp(-Math.pow(distFromTrack / 7.5, 2))
    h -= trackMask * 0.7

    return h
  }

  private bakeBase() {
    const half = this.worldSize * 0.5
    for (let y = 0; y < this.res; y++) {
      const wz = y * this.texel - half
      for (let x = 0; x < this.res; x++) {
        const wx = x * this.texel - half
        this.base[y * this.res + x] = this.heightAt(wx, wz)
      }
    }
    // Pre-soften the central track so it reads as already driven-on.
    const half2 = this.worldSize * 0.5
    for (let y = 0; y < this.res; y++) {
      const wz = y * this.texel - half2
      const meander = this.trackCenterX(wz)
      for (let x = 0; x < this.res; x++) {
        const wx = x * this.texel - half2
        const d = Math.abs(wx - meander)
        const m = Math.exp(-Math.pow(d / 6.5, 2))
        if (m > 0.02) {
          const i = y * this.res + x
          const n = fbm(wx * 0.5, wz * 0.5, 3, 2.0, 0.5, this.seed + 909)
          this.depth[i] = m * (0.05 + n * 0.1)
          this.disturb[i] = m * 0.85
        }
      }
    }
  }

  // ------------------------------------------------------------------ sampling

  private idx(tx: number, ty: number): number {
    const cx = tx < 0 ? 0 : tx >= this.res ? this.res - 1 : tx
    const cy = ty < 0 ? 0 : ty >= this.res ? this.res - 1 : ty
    return cy * this.res + cx
  }

  /** World position → fractional texel coords. */
  private toTexel(wx: number, wz: number): [number, number] {
    const half = this.worldSize * 0.5
    return [(wx + half) / this.texel, (wz + half) / this.texel]
  }

  private bilinear(field: Float32Array, wx: number, wz: number): number {
    const [fx, fy] = this.toTexel(wx, wz)
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const a = field[this.idx(x0, y0)]
    const b = field[this.idx(x0 + 1, y0)]
    const c = field[this.idx(x0, y0 + 1)]
    const d = field[this.idx(x0 + 1, y0 + 1)]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
  }

  /** Static landscape height, no mud. Continuous — safe for physics rays. */
  baseHeight(wx: number, wz: number): number {
    return this.bilinear(this.base, wx, wz)
  }

  /** Final drivable surface including ruts and displaced ridges. */
  surfaceHeight(wx: number, wz: number): number {
    return (
      this.bilinear(this.base, wx, wz) -
      this.bilinear(this.depth, wx, wz) +
      this.bilinear(this.ridge, wx, wz)
    )
  }

  depthAt(wx: number, wz: number): number {
    return this.bilinear(this.depth, wx, wz)
  }

  disturbAt(wx: number, wz: number): number {
    return this.bilinear(this.disturb, wx, wz)
  }

  /** Surface normal from central differences on the final surface. */
  normalAt(wx: number, wz: number, out: { x: number; y: number; z: number }, eps = 0.45) {
    const hL = this.surfaceHeight(wx - eps, wz)
    const hR = this.surfaceHeight(wx + eps, wz)
    const hD = this.surfaceHeight(wx, wz - eps)
    const hU = this.surfaceHeight(wx, wz + eps)
    let nx = hL - hR
    let ny = 2 * eps
    let nz = hD - hU
    const inv = 1 / Math.hypot(nx, ny, nz)
    out.x = nx * inv
    out.y = ny * inv
    out.z = nz * inv
  }

  // --------------------------------------------------------------- deformation

  private markDirty(x0: number, y0: number, x1: number, y1: number) {
    if (this.dx0 > this.dx1) {
      this.dx0 = x0
      this.dx1 = x1
      this.dy0 = y0
      this.dy1 = y1
      return
    }
    if (x0 < this.dx0) this.dx0 = x0
    if (x1 > this.dx1) this.dx1 = x1
    if (y0 < this.dy0) this.dy0 = y0
    if (y1 > this.dy1) this.dy1 = y1
  }

  private markAll() {
    this.dx0 = 0
    this.dy0 = 0
    this.dx1 = this.res - 1
    this.dy1 = this.res - 1
  }

  /**
   * Press a tyre into the mud.
   *
   * Terramechanics, simplified from Bekker–Wong: sinkage rises with ground
   * pressure and falls with soil stiffness. Soil stiffness here is a function of
   * the mud/humidity dashboard knobs, so "85% mud, 70% humidity" really does dig
   * deeper than a dry setting.
   *
   * @param wx,wz   contact centre in world space
   * @param dirX,dirZ  unit heading of the wheel (rut is elongated along it)
   * @param halfWidth  tyre half width, metres
   * @param load    normal force on the tyre, newtons
   * @param softness 0..1 combined mud + humidity
   * @param slip    0..1 wheel slip ratio — spinning tyres dig, rolling ones don't
   * @param distance metres travelled since the last stamp (drives tread spacing)
   */
  stampWheel(
    wx: number,
    wz: number,
    dirX: number,
    dirZ: number,
    halfWidth: number,
    load: number,
    softness: number,
    slip: number,
    distance: number,
  ) {
    // Contact patch grows as the tyre sinks; keep it modest so ruts stay crisp.
    const patchLen = 0.34 + softness * 0.16
    const reach = Math.max(halfWidth, patchLen) + MAX_RIDGE * 3

    const [cfx, cfy] = this.toTexel(wx, wz)
    const r = Math.ceil(reach / this.texel) + 1
    const x0 = Math.max(0, Math.floor(cfx) - r)
    const x1 = Math.min(this.res - 1, Math.ceil(cfx) + r)
    const y0 = Math.max(0, Math.floor(cfy) - r)
    const y1 = Math.min(this.res - 1, Math.ceil(cfy) + r)
    if (x0 > x1 || y0 > y1) return

    /*
     * Ground pressure → sinkage, calibrated against a real reference: a loaded
     * truck tyre puts ~40 kPa on its contact patch, and 40 kPa on fully
     * saturated ground sinks roughly 25 cm. Everything scales from that, so a
     * lighter load or firmer soil produces proportionally shallower ruts.
     */
    const patchArea = 2 * halfWidth * patchLen
    const pressure = load / Math.max(0.01, patchArea)
    let target = (pressure / 40000) * 0.25 * Math.pow(softness, 1.6)
    // A spinning tyre excavates rather than rolls over.
    target *= 1 + slip * 1.2
    target = Math.min(target, MAX_DEPTH)
    if (target < 0.004) return

    // Perpendicular to travel, for the elongated patch and the side berms.
    const px = -dirZ
    const pz = dirX

    const half = this.worldSize * 0.5
    let displaced = 0

    for (let y = y0; y <= y1; y++) {
      const wzc = y * this.texel - half
      for (let x = x0; x <= x1; x++) {
        const wxc = x * this.texel - half
        const rx = wxc - wx
        const rz = wzc - wz
        // Project into (along-travel, across-travel) space.
        const along = rx * dirX + rz * dirZ
        const across = rx * px + rz * pz

        const na = along / patchLen
        const nc = across / halfWidth
        const d2 = na * na + nc * nc
        const i = y * this.res + x

        if (d2 <= 1) {
          // Inside the contact patch: press down with a soft shoulder falloff.
          const falloff = Math.pow(1 - d2, 0.55)
          const want = target * falloff
          if (want > this.depth[i]) {
            displaced += (want - this.depth[i]) * this.texel * this.texel
            this.depth[i] = want
          }
          // Tread imprint: lug bars every ~11 cm along the direction of travel.
          const lug = 0.5 + 0.5 * Math.sin((distance + along) * 57.0)
          this.tread[i] = Math.max(this.tread[i], falloff * lug * (0.35 + slip * 0.65))
          this.disturb[i] = Math.min(1, this.disturb[i] + falloff * 0.6)
        } else if (d2 <= 4) {
          // Berm zone: soil squeezed out of the rut piles up beside it.
          const t = (Math.sqrt(d2) - 1) / 1.0
          const w = Math.max(0, 1 - t) * Math.exp(-t * 2.2)
          const want = Math.min(MAX_RIDGE, target * 0.42 * w)
          if (want > this.ridge[i]) this.ridge[i] = want
          this.disturb[i] = Math.min(1, this.disturb[i] + w * 0.28)
        }
      }
    }

    // Conservation nudge: very deep ruts throw a little extra material outwards.
    if (displaced > 0.02) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * this.res + x
          if (this.ridge[i] > 0) this.ridge[i] = Math.min(MAX_RIDGE, this.ridge[i] * 1.03)
        }
      }
    }

    this.markDirty(x0, y0, x1, y1)
  }

  /**
   * Slow relaxation: wet mud slumps back, tread marks soften, disturbance fades.
   * Runs on a coarse stride so it costs almost nothing per frame.
   */
  relax(dt: number, humidity: number, frame: number) {
    // Soupy mud self-levels noticeably; firm ground barely moves.
    const slump = 0.006 + humidity * 0.05
    const k = 1 - Math.exp(-slump * dt)
    const treadFade = 1 - Math.exp(-(0.02 + humidity * 0.09) * dt)

    // Touch 1/8 of the rows per frame, cycling — 8 frames for a full sweep.
    const stride = 8
    const start = frame % stride
    let touched = false
    for (let y = start; y < this.res; y += stride) {
      for (let x = 0; x < this.res; x++) {
        const i = y * this.res + x
        const d = this.depth[i]
        if (d > 0.0015) {
          this.depth[i] = d - d * k * 0.35
          touched = true
        }
        const r = this.ridge[i]
        if (r > 0.0015) this.ridge[i] = r - r * k
        const t = this.tread[i]
        if (t > 0.004) this.tread[i] = t - t * treadFade
        const s = this.disturb[i]
        if (s > 0.004) this.disturb[i] = s - s * treadFade * 0.25
      }
    }
    if (touched) this.markAll()
  }

  // ------------------------------------------------------------------- upload

  private writePixel(i: number) {
    const o = i * 4
    const d = this.depth[i] / MAX_DEPTH
    const r = this.ridge[i] / MAX_RIDGE
    this.pixels[o] = d > 1 ? 255 : (d * 255) | 0
    this.pixels[o + 1] = r > 1 ? 255 : (r * 255) | 0
    this.pixels[o + 2] = (Math.min(1, this.disturb[i]) * 255) | 0
    this.pixels[o + 3] = (Math.min(1, this.tread[i]) * 255) | 0
  }

  private flushPixels() {
    for (let i = 0; i < this.res * this.res; i++) this.writePixel(i)
  }

  /**
   * Pack the dirty region into a tight RGBA buffer for a sub-image upload.
   * Returns null when nothing changed since the last call.
   */
  consumeDirty(): { x: number; y: number; w: number; h: number; data: Uint8Array } | null {
    if (this.dx0 > this.dx1) return null
    const x = this.dx0
    const y = this.dy0
    const w = this.dx1 - this.dx0 + 1
    const h = this.dy1 - this.dy0 + 1

    const data = new Uint8Array(w * h * 4)
    for (let ry = 0; ry < h; ry++) {
      const srcRow = (y + ry) * this.res
      for (let rx = 0; rx < w; rx++) {
        const i = srcRow + x + rx
        this.writePixel(i)
        const o = (ry * w + rx) * 4
        const s = i * 4
        data[o] = this.pixels[s]
        data[o + 1] = this.pixels[s + 1]
        data[o + 2] = this.pixels[s + 2]
        data[o + 3] = this.pixels[s + 3]
      }
    }

    this.dx0 = 1
    this.dx1 = 0
    this.dy0 = 1
    this.dy1 = 0
    return { x, y, w, h, data }
  }
}
