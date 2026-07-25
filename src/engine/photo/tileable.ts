import { blurPlane, cloneImage, createImage, type RGBAImage } from './types'

/**
 * Seamless tiling — turning one rectified photo into a texture that can repeat
 * across a wall or a ground plane without the eye finding the joins.
 *
 * Two different problems hide under "seam", and they need different cures:
 *
 *  1. A tonal step. The left of the photo was in shade, the right in sun, so
 *     wrapping it puts bright next to dark. No amount of blending hides that —
 *     the blend just smears the step over a wider band. Fixed by high-passing
 *     the image first (`removeLowFrequency`).
 *  2. A structural break. The brick courses simply do not line up. Fixed by the
 *     classic half-offset: wrap the image by half its size so the old outer
 *     edges meet in the middle as a cross, then cross-fade that cross away. The
 *     new outer edges come from the *interior* of the original, so they are
 *     continuous by construction rather than by cleverness.
 */

/** Low-pass radius as a fraction of min(w,h) used when flattening drift.
 *  Large enough to be "the lighting", small enough to leave the texture. */
const DRIFT_RADIUS_FRACTION = 0.25

/** Two adjacent pixels differing by less than this many 8-bit levels read as
 *  identical, so a seam below it is not worth penalising in `tilingScore`. */
const JND_LEVELS = 2

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Hermite fade, clamped. C1 at both ends, so the blend has no visible ridge
 *  where the band starts — a linear ramp leaves exactly that. */
function smoothstep01(t: number): number {
  const u = clamp(t, 0, 1)
  return u * u * (3 - 2 * u)
}

/**
 * Three box passes approximate a Gaussian. A single box leaves square halos,
 * and here those halos get subtracted straight back into the image as
 * rectangular ghosts. 0.58 matches one box of `radius` in standard deviation.
 */
function smoothPlane(plane: Float32Array, width: number, height: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius * 0.58))
  let out = blurPlane(plane, width, height, r)
  out = blurPlane(out, width, height, r)
  return blurPlane(out, width, height, r)
}

/**
 * Flatten large-scale brightness and colour drift: subtract a heavily blurred
 * copy of each channel and add the channel's global mean back, so the average
 * exposure and the overall hue survive while "the top-left corner is warmer"
 * does not. `radiusFraction` is the blur radius as a fraction of the shorter
 * edge, clamped to 0.02..1.
 *
 * Alpha is passed through untouched — high-passing a mask is meaningless.
 *
 * Done per channel rather than on luma alone on purpose: a photo taken half in
 * open shade has a *blue* gradient, not just a dark one, and a luma-only fix
 * leaves the colour cast to reappear as a coloured seam.
 */
export function removeLowFrequency(img: RGBAImage, radiusFraction: number): RGBAImage {
  const { width, height } = img
  const n = width * height
  const out = cloneImage(img)
  if (n < 1) return out

  const radius = clamp(radiusFraction, 0.02, 1) * Math.min(width, height)
  const plane = new Float32Array(n)
  for (let c = 0; c < 3; c++) {
    let mean = 0
    for (let p = 0, i = c; p < n; p++, i += 4) {
      const v = img.data[i] / 255
      plane[p] = v
      mean += v
    }
    mean /= n
    const low = smoothPlane(plane, width, height, radius)
    // Uint8ClampedArray clamps for us. Clipping is real loss, but a channel
    // that clips here was already blown out in the source.
    for (let p = 0, i = c; p < n; p++, i += 4) {
      out.data[i] = (plane[p] - low[p] + mean) * 255
    }
  }
  return out
}

/**
 * One axis of the offset-and-blend. Shifts by half the axis length so the old
 * wrap point lands in the middle, then cross-fades that seam with the un-shifted
 * image — which is smooth exactly where the shifted one is broken, and broken
 * exactly where its own weight has fallen to zero.
 *
 * Separable on purpose. Doing both axes at once needs a 2D weight, and every
 * 2D weight that is non-zero on the frame edge drags the *original* seam back
 * onto the new border. Running x then y sidesteps that: the second pass only
 * ever mixes whole rows, so the horizontal continuity the first pass
 * established is carried through untouched.
 */
function offsetBlendAxis(src: RGBAImage, blend: number, vertical: boolean): RGBAImage {
  const w = src.width
  const h = src.height
  const n = vertical ? h : w
  const half = n >> 1
  if (n < 4) return cloneImage(src)

  // Cap the band so the weight is exactly zero on both frame edges. That cap,
  // not the blend maths, is what makes the wrap continuous by construction.
  const band = Math.min(clamp(blend, 0, 1) * n * 0.5, half - 0.5)
  const weight = new Float32Array(n)
  if (band > 0) {
    for (let i = 0; i < n; i++) {
      // Distance from the seam line at `half` to this pixel's centre.
      weight[i] = 0.5 * (1 - smoothstep01(Math.abs(i + 0.5 - half) / band))
    }
  }

  const out = createImage(w, h)
  if (vertical) {
    for (let y = 0; y < h; y++) {
      const a = weight[y]
      const ka = 1 - a
      const shifted = ((y + half) % h) * w * 4
      const plain = y * w * 4
      for (let x = 0, o = plain; x < w; x++, o += 4) {
        const p = x * 4
        for (let k = 0; k < 4; k++) {
          out.data[o + k] = src.data[shifted + p + k] * ka + src.data[plain + p + k] * a
        }
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      const row = y * w * 4
      for (let x = 0; x < w; x++) {
        const a = weight[x]
        const ka = 1 - a
        const shifted = row + ((x + half) % w) * 4
        const plain = row + x * 4
        for (let k = 0; k < 4; k++) {
          out.data[plain + k] = src.data[shifted + k] * ka + src.data[plain + k] * a
        }
      }
    }
  }
  return out
}

/**
 * Make `img` repeat without a visible join. `blend` is the cross-fade width as
 * a fraction of the image size; ~0.12 suits most surfaces, wider for noisy
 * stone, narrower for anything with strong lines that would ghost.
 *
 * Column 0 is continuous with column w-1 and row 0 with row h-1 *exactly*:
 * after the half-offset those pairs are adjacent pixels from the middle of the
 * source, and the blend weight is pinned to zero there.
 *
 * Honest limitation: with a fixed output size the second layer must fade back
 * out before the frame edge, so the fade can only be a symmetric bump peaking
 * at 50/50. A monotonic 0→1 cross-fade would cancel the step outright but needs
 * to consume `blend` of the width, shrinking the texture. At 50/50 the residual
 * on the seam line is at most half the original step — sitting inside a wide
 * gradient, where the eye reads it as softness rather than as an edge — and
 * step 1 has already removed the part of it that was tonal drift.
 */
export function makeTileable(img: RGBAImage, blend: number): RGBAImage {
  if (img.width < 4 || img.height < 4) return cloneImage(img)
  const flat = removeLowFrequency(img, DRIFT_RADIUS_FRACTION)
  return offsetBlendAxis(offsetBlendAxis(flat, blend, false), blend, true)
}

/** Mean absolute RGB difference between two pixel offsets, in 8-bit levels. */
function pixelDiff(data: Uint8ClampedArray, a: number, b: number): number {
  return (
    Math.abs(data[a] - data[b]) +
    Math.abs(data[a + 1] - data[b + 1]) +
    Math.abs(data[a + 2] - data[b + 2])
  ) / 3
}

/** Value at quantile `q` of an already-sorted list. */
function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0
  return sorted[clamp(Math.round(q * (sorted.length - 1)), 0, sorted.length - 1)]
}

/**
 * Seam difference against the reference transition, mapped to 0..1.
 * 1 means the wrap is no more of a break than the texture's own contrastier
 * transitions, which is the point at which it stops being findable.
 */
function axisScore(seam: number, reference: number): number {
  const ratio = seam / Math.max(reference, JND_LEVELS)
  return 1 / (1 + Math.max(0, ratio - 1))
}

/**
 * How well the image tiles, 0..1. Compares the pixel lines that become
 * neighbours when the texture repeats (column w-1 against column 0, row h-1
 * against row 0) with the transitions already present inside the image.
 *
 * Relative rather than absolute because "how big a jump is too big" depends
 * entirely on the material: a 12-level step is invisible on gravel and glaring
 * on smooth plaster.
 *
 * The reference is the 90th percentile of the interior line-to-line
 * differences, not their mean. A brick wall has mortar courses and a stone
 * floor has cracks, so interior differences are wildly non-uniform; measured
 * against the mean, a wrap that landed on a perfectly ordinary contrasty
 * transition would be reported as a defect. Against the 90th percentile, a
 * wrap only loses points once it is a bigger jump than the texture itself
 * routinely makes. The floor at `JND_LEVELS` stops a near-flat image from
 * scoring badly over a step nobody can see.
 */
export function tilingScore(img: RGBAImage): number {
  const { width: w, height: h, data } = img
  if (w < 2 || h < 2) return 1

  const colDiff = new Float64Array(w - 1)
  let seamH = 0
  for (let y = 0; y < h; y++) {
    const row = y * w * 4
    seamH += pixelDiff(data, row + (w - 1) * 4, row)
    for (let x = 0; x + 1 < w; x++) colDiff[x] += pixelDiff(data, row + x * 4, row + (x + 1) * 4)
  }
  seamH /= h
  for (let x = 0; x < colDiff.length; x++) colDiff[x] /= h

  const rowDiff = new Float64Array(h - 1)
  let seamV = 0
  const last = (h - 1) * w * 4
  for (let x = 0; x < w; x++) seamV += pixelDiff(data, last + x * 4, x * 4)
  for (let y = 0; y + 1 < h; y++) {
    const row = y * w * 4
    const next = row + w * 4
    for (let x = 0; x < w; x++) rowDiff[y] += pixelDiff(data, row + x * 4, next + x * 4)
  }
  seamV /= w
  for (let y = 0; y < rowDiff.length; y++) rowDiff[y] /= w

  colDiff.sort()
  rowDiff.sort()

  // Geometric mean: one bad axis should pull the number down hard without
  // pretending the other axis is broken too.
  const sh = axisScore(seamH, quantile(colDiff, 0.9))
  const sv = axisScore(seamV, quantile(rowDiff, 0.9))
  return clamp(Math.sqrt(sh * sv), 0, 1)
}
