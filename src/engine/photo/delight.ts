import { blurPlane, cloneImage, createImage, luma, type RGBAImage } from './types'

/**
 * De-lighting — removing the lighting that was baked into a photo so the
 * result reacts to the game's lights instead of carrying the sun that happened
 * to be shining when the shutter opened.
 *
 * The method is homomorphic filtering. A photo is roughly
 * reflectance × illumination; taking logs turns that product into a sum, and
 * illumination is the slow-varying term while reflectance is the fast one. So a
 * heavy low-pass of the log-luma *is* the lighting, and subtracting it leaves
 * the material behind.
 */

export interface DelightResult {
  albedo: RGBAImage
  /** Low-frequency lighting, 0..1 with 1 = fully lit. Doubles as an AO prior. */
  illumination: Float32Array
}

/** Low-pass radius as a fraction of min(w,h). Big enough for a sun gradient,
 *  small enough that real tonal variation (a dark plinth) survives. */
const DEFAULT_RADIUS_FRACTION = 0.25

/** Luma below this is sensor noise, where a brightness *ratio* means nothing. */
const NOISE_FLOOR = 0.02

/** Gain limits. Asymmetric: lifting a shadow is the point, crushing a highlight
 *  past a quarter is almost always the low-pass leaking a real bright object. */
const MIN_GAIN = 0.25
const MAX_GAIN = 5

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** log(1 + L) with L in 0..1. log1p rather than log keeps near-black stable. */
function logLumaPlane(img: RGBAImage): Float32Array {
  const out = new Float32Array(img.width * img.height)
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    out[p] = Math.log1p(luma(img.data[i], img.data[i + 1], img.data[i + 2]) / 255)
  }
  return out
}

/**
 * Three box passes to approximate a Gaussian. One pass on its own leaves square
 * halos around bright windows, and those halos get subtracted straight into the
 * albedo as rectangular ghosts — painfully visible on a flat wall. 0.58 is the
 * per-pass radius that matches a single box of `radius` in standard deviation.
 */
function smoothPlane(plane: Float32Array, width: number, height: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius * 0.58))
  let out = blurPlane(plane, width, height, r)
  out = blurPlane(out, width, height, r)
  return blurPlane(out, width, height, r)
}

/** Split a photo into log-luma and its low-frequency (lighting) component. */
function decompose(img: RGBAImage, radiusFraction: number): { logL: Float32Array; low: Float32Array } {
  const { width, height } = img
  const logL = logLumaPlane(img)
  if (width < 1 || height < 1) return { logL, low: logL.slice() }
  const radius = clamp(radiusFraction, 0.02, 1) * Math.min(width, height)
  return { logL, low: smoothPlane(logL, width, height, radius) }
}

/** Value at quantile `q` via histogram — a full sort of a megapixel is wasteful
 *  and we only need ~0.2% precision here. Input is known to be 0..1. */
function percentile(plane: Float32Array, q: number): number {
  const bins = 512
  const hist = new Uint32Array(bins)
  for (let p = 0; p < plane.length; p++) {
    hist[clamp(Math.round(plane[p] * (bins - 1)), 0, bins - 1)]++
  }
  const target = plane.length * q
  let acc = 0
  for (let b = 0; b < bins; b++) {
    acc += hist[b]
    if (acc >= target) return b / (bins - 1)
  }
  return 1
}

/**
 * Log-domain lighting back to linear, normalised so the lit majority sits at 1.
 * Anchoring on the 98th percentile rather than the max stops one specular blob
 * from scaling the whole plane down and faking occlusion everywhere.
 */
function illuminationFromLog(low: Float32Array): Float32Array {
  const out = new Float32Array(low.length)
  for (let p = 0; p < low.length; p++) out[p] = Math.expm1(low[p])
  const top = percentile(out, 0.98)
  const scale = top > 1e-4 ? 1 / top : 1
  for (let p = 0; p < out.length; p++) out[p] = clamp(out[p] * scale, 0, 1)
  return out
}

/**
 * Estimate the baked lighting on its own. `radiusFraction` is the low-pass
 * radius as a fraction of the shorter edge (~0.25 is a good default); it is
 * clamped to 0.02..1 because anything smaller starts eating the texture itself.
 */
export function estimateIllumination(img: RGBAImage, radiusFraction: number): Float32Array {
  return illuminationFromLog(decompose(img, radiusFraction).low)
}

/**
 * Remove baked lighting. `strength` 0..1: 0 returns the input untouched,
 * 1 removes as much as is safe.
 */
export function delight(img: RGBAImage, strength: number): DelightResult {
  const { width, height } = img
  const n = width * height
  const { logL, low } = decompose(img, DEFAULT_RADIUS_FRACTION)
  const illumination = illuminationFromLog(low)
  const s = clamp(strength, 0, 1)
  if (s <= 0 || n < 1) return { albedo: cloneImage(img), illumination }

  // Subtract the *deviation* from the mean of the low-pass, not the low-pass
  // itself: that divides out the lighting gradient while leaving the average
  // exposure alone, so a de-lit texture never comes out uniformly darker.
  let meanLow = 0
  for (let p = 0; p < n; p++) meanLow += low[p]
  meanLow /= n

  const flat = new Float32Array(n)
  for (let p = 0; p < n; p++) {
    flat[p] = clamp(Math.expm1(logL[p] - s * (low[p] - meanLow)), 0, 1)
  }

  // Dividing by a blurred copy of yourself always softens local contrast a
  // little; a mild unsharp at grain scale puts the surface texture back.
  const detailRadius = Math.max(1, Math.round(Math.min(width, height) * 0.01))
  const soft = blurPlane(flat, width, height, detailRadius)
  const sharpen = 0.35 * s
  for (let p = 0; p < n; p++) {
    flat[p] = clamp(flat[p] + sharpen * (flat[p] - soft[p]), 0, 1)
  }

  // Arithmetic-mean match. The log-domain trick above preserves the *geometric*
  // mean, which still drifts a percent or two in perceived brightness.
  let sumSrc = 0
  let sumOut = 0
  for (let p = 0; p < n; p++) {
    sumSrc += Math.expm1(logL[p])
    sumOut += flat[p]
  }
  const renorm = sumOut > 1e-6 ? sumSrc / sumOut : 1

  const albedo = createImage(width, height)
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const src = Math.expm1(logL[p])
    let g = clamp((flat[p] * renorm) / Math.max(src, NOISE_FLOOR), MIN_GAIN, MAX_GAIN)
    // Fade the correction out in near-black pixels, where a large gain would
    // only amplify sensor noise into coloured speckle.
    g = 1 + (g - 1) * clamp(src / NOISE_FLOOR, 0, 1)

    // Apply as a luminance gain on the original RGB — recomputing colour from
    // the corrected luma would flatten hue and kill the material's identity.
    let r = img.data[i] * g
    let gg = img.data[i + 1] * g
    let b = img.data[i + 2] * g
    const peak = r > gg ? (r > b ? r : b) : gg > b ? gg : b
    // Rescale all three together rather than letting each clamp at 255
    // independently, which would drag bright pixels toward white.
    if (peak > 255) {
      const k = 255 / peak
      r *= k
      gg *= k
      b *= k
    }
    albedo.data[i] = r
    albedo.data[i + 1] = gg
    albedo.data[i + 2] = b
    albedo.data[i + 3] = img.data[i + 3]
  }

  return { albedo, illumination }
}

/**
 * Grey-world white balance: assume the scene averages to neutral and scale each
 * channel toward the common mean. The assumption is wrong for a genuinely
 * coloured surface, so the correction is both exponent-damped by how saturated
 * the photo is and hard-clamped — a red door stays a red door.
 */
export function autoWhiteBalance(img: RGBAImage): RGBAImage {
  const out = cloneImage(img)
  if (img.width < 1 || img.height < 1) return out

  let sr = 0
  let sg = 0
  let sb = 0
  let sat = 0
  let count = 0
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 8) continue
    const r = img.data[i]
    const g = img.data[i + 1]
    const b = img.data[i + 2]
    const hi = r > g ? (r > b ? r : b) : g > b ? g : b
    // Clipped and near-black pixels carry no usable chroma and would pull every
    // channel mean together, faking a scene that is already neutral.
    if (hi >= 250 || hi < 6) continue
    const lo = r < g ? (r < b ? r : b) : g < b ? g : b
    sat += (hi - lo) / hi
    sr += r
    sg += g
    sb += b
    count++
  }
  if (count === 0) return out

  const mr = sr / count
  const mg = sg / count
  const mb = sb / count
  const target = (mr + mg + mb) / 3
  const meanSat = sat / count
  // Below ~0.15 mean saturation the scene really is mostly neutral and we can
  // trust grey-world; past ~0.5 it is a coloured surface and we back off fully.
  const confidence = clamp(1 - (meanSat - 0.15) / 0.35, 0, 1)
  const k = 0.8 * confidence

  const gain = (m: number): number => clamp(Math.pow(target / Math.max(m, 1), k), 0.7, 1.4)
  let kr = gain(mr)
  let kg = gain(mg)
  let kb = gain(mb)
  // White balance corrects colour, not exposure, so divide out the luma the
  // gains would have added.
  const lw = luma(kr, kg, kb)
  if (lw > 1e-4) {
    kr /= lw
    kg /= lw
    kb /= lw
  }

  for (let i = 0; i < img.data.length; i += 4) {
    out.data[i] = img.data[i] * kr
    out.data[i + 1] = img.data[i + 1] * kg
    out.data[i + 2] = img.data[i + 2] * kb
  }
  return out
}
