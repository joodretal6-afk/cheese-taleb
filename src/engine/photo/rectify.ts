/**
 * Perspective correction — stage one of turning a phone photo of a wall, door
 * or patch of ground into a flat texture.
 *
 * All of it is plain arithmetic over plain data: no canvas, no matrix library,
 * no DOM. That keeps the stage runnable in a worker and unit-testable in Node,
 * and it means the 8x8 solve below is written out by hand on purpose.
 */

import {
  type Pt,
  type Quad,
  type RGBAImage,
  createImage,
  luma,
  blurPlane,
  sampleBilinear,
} from './types'

/** 3x3 projective transform, row-major, 9 entries. */
export interface Homography {
  m: Float64Array
}

// -------------------------------------------------------------- homography

function identity(): Homography {
  return { m: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]) }
}

/**
 * Fallback for quads a homography cannot be fitted to (collinear corners, zero
 * area). Stretching the quad's bounding box onto the output still gives the
 * user something recognisable to look at, which beats a buffer full of NaN.
 */
function boxHomography(src: Quad, dstW: number, dstH: number): Homography {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of src) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return identity()
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const w = maxX - minX
  const h = maxY - minY
  if (!(w > 1e-6) || !(h > 1e-6) || !(dstW > 0) || !(dstH > 0)) return identity()
  const sx = dstW / w
  const sy = dstH / h
  return { m: Float64Array.from([sx, 0, -minX * sx, 0, sy, -minY * sy, 0, 0, 1]) }
}

/** Signed shoelace area. Positive for a TL,TR,BR,BL quad in y-down image space. */
function quadArea(q: Quad): number {
  let acc = 0
  for (let i = 0; i < 4; i++) {
    const a = q[i]
    const b = q[(i + 1) % 4]
    acc += a.x * b.y - b.x * a.y
  }
  return acc / 2
}

/**
 * Gaussian elimination with partial pivoting on an 8x8 system, in place.
 * Returns null when the system is singular — the caller falls back rather than
 * propagating infinities into the pixel loop.
 */
function solve8(a: Float64Array, b: Float64Array): Float64Array | null {
  const n = 8
  let scale = 0
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i])
    if (v > scale) scale = v
  }
  const tol = 1e-12 * Math.max(1, scale)

  for (let col = 0; col < n; col++) {
    let piv = col
    let best = Math.abs(a[col * n + col])
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r * n + col])
      if (v > best) {
        best = v
        piv = r
      }
    }
    if (best < tol) return null
    if (piv !== col) {
      for (let c = 0; c < n; c++) {
        const t = a[col * n + c]
        a[col * n + c] = a[piv * n + c]
        a[piv * n + c] = t
      }
      const t = b[col]
      b[col] = b[piv]
      b[piv] = t
    }
    const d = a[col * n + col]
    for (let r = col + 1; r < n; r++) {
      const f = a[r * n + col] / d
      if (f === 0) continue
      for (let c = col; c < n; c++) a[r * n + c] -= f * a[col * n + c]
      b[r] -= f * b[col]
    }
  }

  const x = new Float64Array(n)
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]
    for (let c = r + 1; c < n; c++) s -= a[r * n + c] * x[c]
    x[r] = s / a[r * n + r]
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(x[i])) return null
  return x
}

/**
 * Fit the transform that carries the four source corners (TL,TR,BR,BL) onto the
 * rectangle (0,0)-(dstW,dstH).
 *
 * Four correspondences give eight equations; the ninth entry is pinned to 1
 * because a homography is only defined up to scale. That normalisation keeps
 * every entry at a sane magnitude, which is what makes the analytic inverse in
 * `rectify` numerically safe.
 */
export function computeHomography(src: Quad, dstW: number, dstH: number): Homography {
  const dst: Quad = [
    { x: 0, y: 0 },
    { x: dstW, y: 0 },
    { x: dstW, y: dstH },
    { x: 0, y: dstH },
  ]

  // Reject up front what the solver would only discover as a tiny pivot: a
  // collinear or zero-area quad carries no perspective information at all.
  const area = quadArea(src)
  if (!Number.isFinite(area) || Math.abs(area) < 1e-9) return boxHomography(src, dstW, dstH)

  const a = new Float64Array(64)
  const b = new Float64Array(8)
  for (let i = 0; i < 4; i++) {
    const s = src[i]
    const d = dst[i]
    const r0 = i * 2 * 8
    a[r0] = s.x
    a[r0 + 1] = s.y
    a[r0 + 2] = 1
    a[r0 + 6] = -d.x * s.x
    a[r0 + 7] = -d.x * s.y
    b[i * 2] = d.x

    const r1 = (i * 2 + 1) * 8
    a[r1 + 3] = s.x
    a[r1 + 4] = s.y
    a[r1 + 5] = 1
    a[r1 + 6] = -d.y * s.x
    a[r1 + 7] = -d.y * s.y
    b[i * 2 + 1] = d.y
  }

  const h = solve8(a, b)
  if (!h) return boxHomography(src, dstW, dstH)

  const m = new Float64Array(9)
  m.set(h, 0)
  m[8] = 1
  return { m }
}

/** Analytic 3x3 inverse via the adjugate. Null when the matrix is singular. */
function invert3x3(h: Homography): Homography | null {
  const m = h.m
  const c0 = m[4] * m[8] - m[5] * m[7]
  const c1 = m[5] * m[6] - m[3] * m[8]
  const c2 = m[3] * m[7] - m[4] * m[6]
  const det = m[0] * c0 + m[1] * c1 + m[2] * c2
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  const id = 1 / det
  const out = new Float64Array(9)
  out[0] = c0 * id
  out[1] = (m[2] * m[7] - m[1] * m[8]) * id
  out[2] = (m[1] * m[5] - m[2] * m[4]) * id
  out[3] = c1 * id
  out[4] = (m[0] * m[8] - m[2] * m[6]) * id
  out[5] = (m[2] * m[3] - m[0] * m[5]) * id
  out[6] = c2 * id
  out[7] = (m[1] * m[6] - m[0] * m[7]) * id
  out[8] = (m[0] * m[4] - m[1] * m[3]) * id
  return { m: out }
}

/**
 * Resample the quad out of `img` into a flat outW x outH raster.
 *
 * Inverse mapping (destination pixel -> source position) rather than forward
 * mapping, so every output texel is written exactly once and no holes appear
 * where the source is stretched.
 */
export function rectify(img: RGBAImage, quad: Quad, outW: number, outH: number): RGBAImage {
  const w = Math.max(1, Math.floor(outW))
  const h = Math.max(1, Math.floor(outH))
  const out = createImage(w, h)
  if (img.width < 1 || img.height < 1) return out

  const forward = computeHomography(quad, w, h)
  const inv = invert3x3(forward) ?? invert3x3(boxHomography(quad, w, h)) ?? identity()
  const m = inv.m

  const px: number[] = [0, 0, 0, 0]
  for (let y = 0; y < h; y++) {
    // The projective numerators are affine in x, so step them along the row
    // instead of doing a full matrix multiply per pixel — this is the hot loop
    // at 4096x4096 output sizes.
    const dy = y + 0.5
    let nx = m[0] * 0.5 + m[1] * dy + m[2]
    let ny = m[3] * 0.5 + m[4] * dy + m[5]
    let nw = m[6] * 0.5 + m[7] * dy + m[8]
    let i = y * w * 4

    for (let x = 0; x < w; x++, i += 4) {
      // Points on the horizon divide by zero; nudging keeps them merely very
      // far away, where sampleBilinear's edge clamping handles them.
      const d = Math.abs(nw) < 1e-12 ? (nw < 0 ? -1e-12 : 1e-12) : nw
      // Corners are continuous image coordinates, sampleBilinear puts pixel
      // centres on integers — hence the half-texel shift.
      sampleBilinear(img, nx / d - 0.5, ny / d - 0.5, px)
      out.data[i] = px[0]
      out.data[i + 1] = px[1]
      out.data[i + 2] = px[2]
      out.data[i + 3] = px[3]
      nx += m[0]
      ny += m[3]
      nw += m[6]
    }
  }
  return out
}

// ------------------------------------------------------------ auto-detection

/** Long edge of the plane the detector works on. Small on purpose: we want the
 *  dominant structure of the scene, not its brick grain. */
const AUTO_MAX_DIM = 256
/** Widest tilt considered, as d(offset)/d(other axis). ~19 degrees. */
const SLOPE_LIMIT = 0.35
const SLOPE_STEPS = 13
/** Fraction of the image searched from each border for that border's edge. */
const BORDER_BAND = 0.4
/** Peak-over-mean line score below which we do not trust the detection.
 *  Empirical: a flat, evenly textured surface sits near 1.2-1.5. */
const MIN_CONFIDENCE = 2.2
/** How far the winner must beat the best *other* line in its band. Repeating
 *  structure — brick courses, tiling, slats — produces many equally strong
 *  lines, and picking one of them at random is worse than not guessing. */
const MIN_UNIQUENESS = 1.3
/** Inset used by the fallback quad. */
const INSET = 0.05

const SLOPES = (() => {
  const out: number[] = []
  for (let i = 0; i < SLOPE_STEPS; i++) {
    out.push(-SLOPE_LIMIT + (2 * SLOPE_LIMIT * i) / (SLOPE_STEPS - 1))
  }
  return out
})()

interface LineFit {
  /** Position on the search axis, measured at the plane's centre line. */
  offset: number
  /** Tilt: offset drifts by `slope` per pixel along the other axis. */
  slope: number
  /** Peak score over the mean score of the band. ~1 means "nothing here". */
  confidence: number
  /** Peak score over the best clearly-separated rival in the same band. */
  uniqueness: number
}

/** Box-average straight to luma. Avoids materialising a float plane the size of
 *  a 12MP photo just to throw 99% of it away. */
function downscaleLuma(img: RGBAImage, tw: number, th: number): Float32Array {
  const out = new Float32Array(tw * th)
  const fx = img.width / tw
  const fy = img.height / th
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * fy)
    const y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) * fy)))
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * fx)
      const x1 = Math.max(x0 + 1, Math.min(img.width, Math.floor((x + 1) * fx)))
      let sum = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * img.width + x0) * 4
        for (let sx = x0; sx < x1; sx++, i += 4) {
          sum += luma(img.data[i], img.data[i + 1], img.data[i + 2])
          n++
        }
      }
      out[y * tw + x] = n > 0 ? sum / (n * 255) : 0
    }
  }
  return out
}

function sobel(plane: Float32Array, w: number, h: number): { gx: Float32Array; gy: Float32Array } {
  const gx = new Float32Array(w * h)
  const gy = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const tl = plane[i - w - 1]
      const tc = plane[i - w]
      const tr = plane[i - w + 1]
      const ml = plane[i - 1]
      const mr = plane[i + 1]
      const bl = plane[i + w - 1]
      const bc = plane[i + w]
      const br = plane[i + w + 1]
      gx[i] = tr + 2 * mr + br - (tl + 2 * ml + bl)
      gy[i] = bl + 2 * bc + br - (tl + 2 * tc + tr)
    }
  }
  return { gx, gy }
}

function transpose(plane: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(plane.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[x * h + y] = plane[y * w + x]
  }
  return out
}

/** How many rows of the plane the line x = off + s*(y - cy) stays inside. */
function lineSpan(off: number, s: number, w: number, h: number): number {
  if (off < 0 || off > w - 1) return 0
  if (s === 0) return h
  const cy = (h - 1) / 2
  const ya = cy + (0 - off) / s
  const yb = cy + (w - 1 - off) / s
  const lo = Math.max(0, Math.min(ya, yb))
  const hi = Math.min(h - 1, Math.max(ya, yb))
  return hi > lo ? hi - lo + 1 : 0
}

/**
 * Score every candidate near-vertical line as mean edge energy along it.
 * `gp` is the gradient across the line, `gs` the one along it; only pixels
 * where the across-component dominates vote, so horizontal detail cannot
 * masquerade as a vertical edge.
 */
function accumulateLines(gp: Float32Array, gs: Float32Array, w: number, h: number): Float32Array {
  const steps = SLOPES.length
  const score = new Float32Array(steps * w)
  const cy = (h - 1) / 2
  for (let y = 0; y < h; y++) {
    const dy = y - cy
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const a = Math.abs(gp[i])
      if (a <= Math.abs(gs[i])) continue
      for (let si = 0; si < steps; si++) {
        const off = Math.round(x - SLOPES[si] * dy)
        if (off < 0 || off >= w) continue
        score[si * w + off] += a
      }
    }
  }
  // Normalise by visible length, and discard lines that mostly leave the frame
  // — a short bright fragment is not a wall edge.
  const minSpan = 0.6 * h
  for (let si = 0; si < steps; si++) {
    for (let off = 0; off < w; off++) {
      const span = lineSpan(off, SLOPES[si], w, h)
      score[si * w + off] = span >= minSpan ? score[si * w + off] / span : 0
    }
  }
  return score
}

function bestLine(score: Float32Array, w: number, lo: number, hi: number): LineFit {
  let peak = 0
  let bestOff = (lo + hi) / 2
  let bestSlope = 0
  let total = 0
  let n = 0
  for (let si = 0; si < SLOPES.length; si++) {
    for (let off = lo; off <= hi; off++) {
      const v = score[si * w + off]
      if (v <= 0) continue
      total += v
      n++
      if (v > peak) {
        peak = v
        bestOff = off
        bestSlope = SLOPES[si]
      }
    }
  }
  const mean = n > 0 ? total / n : 0

  // Best rival far enough away not to be the same edge seen at a neighbouring
  // offset or slope.
  const sep = Math.max(2, (hi - lo) / 4)
  let rival = 0
  for (let si = 0; si < SLOPES.length; si++) {
    for (let off = lo; off <= hi; off++) {
      if (Math.abs(off - bestOff) < sep) continue
      const v = score[si * w + off]
      if (v > rival) rival = v
    }
  }

  return {
    offset: bestOff,
    slope: bestSlope,
    confidence: mean > 0 ? peak / mean : 0,
    uniqueness: rival > 0 ? peak / rival : peak > 0 ? Infinity : 0,
  }
}

/** Intersect x = v.offset + v.slope*(y-cy) with y = hl.offset + hl.slope*(x-cx). */
function intersect(v: LineFit, hl: LineFit, cx: number, cy: number): Pt {
  const s = v.slope
  const t = hl.slope
  const den = 1 - s * t
  if (Math.abs(den) < 1e-6) return { x: v.offset, y: hl.offset }
  const x = (v.offset + s * (hl.offset - cy - t * cx)) / den
  return { x, y: hl.offset + t * (x - cx) }
}

function insetQuad(width: number, height: number): Quad {
  const ix = width * INSET
  const iy = height * INSET
  return [
    { x: ix, y: iy },
    { x: width - ix, y: iy },
    { x: width - ix, y: height - iy },
    { x: ix, y: height - iy },
  ]
}

function orInset(fit: LineFit, insetOffset: number): LineFit {
  if (fit.confidence >= MIN_CONFIDENCE && fit.uniqueness >= MIN_UNIQUENESS) return fit
  return { offset: insetOffset, slope: 0, confidence: 0, uniqueness: 0 }
}

/**
 * Propose the quad the user most likely meant: Sobel edge magnitude on a small
 * luma plane, then the strongest near-vertical line in each of the left/right
 * border bands and the strongest near-horizontal line in each of the top/bottom
 * bands, intersected into four corners.
 *
 * Honest limitation: this assumes the subject is one large quadrilateral facing
 * the camera and roughly filling the frame. A doorframe behind the wall, a
 * shadow line, or a floor/ceiling junction will happily win over the intended
 * edge; repeating structure (brick courses, tiles, slats) is deliberately
 * rejected rather than guessed at; and any side the detector is unsure about
 * silently falls back to a 5% inset. Treat the result as a starting point for
 * the user to drag, never as a detection guarantee — the UI must always keep
 * the corner handles visible and editable.
 */
export function autoDetectQuad(img: RGBAImage): Quad {
  if (img.width < 1 || img.height < 1) {
    return [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]
  }
  const fallback = insetQuad(img.width, img.height)

  const k = Math.min(1, AUTO_MAX_DIM / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * k))
  const h = Math.max(1, Math.round(img.height * k))
  if (w < 16 || h < 16) return fallback

  // Blur before Sobel: at this scale a single pixel of brick mortar or gravel
  // is pure noise, and it otherwise dominates the accumulator.
  const plane = blurPlane(downscaleLuma(img, w, h), w, h, 1)
  const { gx, gy } = sobel(plane, w, h)

  const vScore = accumulateLines(gx, gy, w, h)
  // Horizontal lines are the same search on the transposed gradients, with the
  // roles of gx and gy swapped — no second accumulator needed.
  const hScore = accumulateLines(transpose(gy, w, h), transpose(gx, w, h), h, w)

  const vBand = Math.max(1, Math.floor((w - 1) * BORDER_BAND))
  const hBand = Math.max(1, Math.floor((h - 1) * BORDER_BAND))
  const left = orInset(bestLine(vScore, w, 0, vBand), (w - 1) * INSET)
  const right = orInset(bestLine(vScore, w, w - 1 - vBand, w - 1), (w - 1) * (1 - INSET))
  const top = orInset(bestLine(hScore, h, 0, hBand), (h - 1) * INSET)
  const bottom = orInset(bestLine(hScore, h, h - 1 - hBand, h - 1), (h - 1) * (1 - INSET))

  if (right.offset - left.offset < 0.15 * (w - 1)) return fallback
  if (bottom.offset - top.offset < 0.15 * (h - 1)) return fallback

  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  const corners: Pt[] = [
    intersect(left, top, cx, cy),
    intersect(right, top, cx, cy),
    intersect(right, bottom, cx, cy),
    intersect(left, bottom, cx, cy),
  ]

  const sx = img.width / w
  const sy = img.height / h
  const quad = corners.map((p) => ({
    // Plane index i covers full-res pixels [i*sx, (i+1)*sx); its centre is the
    // coordinate the line actually sits on.
    x: Math.max(0, Math.min(img.width, (p.x + 0.5) * sx)),
    y: Math.max(0, Math.min(img.height, (p.y + 0.5) * sy)),
  })) as Quad

  for (const p of quad) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return fallback
  // A detection that folded over itself is worse than no detection.
  if (quadArea(quad) < 0.02 * img.width * img.height) return fallback
  return quad
}

// ---------------------------------------------------------------- aspect

function dist(a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.hypot(dx, dy)
}

/**
 * Estimate the real width/height ratio of the photographed rectangle from the
 * average of the two horizontal edges over the average of the two vertical
 * ones.
 *
 * This is only exact for a fronto-parallel plane. Under real perspective the
 * near edge is longer than the far one, and averaging merely splits the
 * difference — it does not recover the true ratio, which would need the
 * vanishing points and the camera's focal length. Good enough to pick a
 * sensible default output resolution; not good enough to measure a door.
 */
export function suggestAspect(quad: Quad): number {
  const [tl, tr, br, bl] = quad
  const wide = (dist(tl, tr) + dist(bl, br)) / 2
  const tall = (dist(tl, bl) + dist(tr, br)) / 2
  if (!Number.isFinite(wide) || !Number.isFinite(tall) || tall < 1e-6 || wide < 1e-6) return 1
  // Clamped: a degenerate sliver would otherwise ask the pipeline for a
  // 100000x1 texture.
  return Math.max(1 / 16, Math.min(16, wide / tall))
}
