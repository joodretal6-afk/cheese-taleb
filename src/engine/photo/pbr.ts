import { blurPlane, cloneImage, createImage, fromPlane, toLumaPlane, type PbrMaps, type RGBAImage } from './types'

/**
 * PBR channel derivation — turning one de-lit photo into the normal / roughness
 * / AO / height set a game material needs.
 *
 * There is no real depth information in a single photograph, so every map here
 * is an inference from albedo structure. The one assumption that carries the
 * whole file is that on a weathered surface *darker means recessed*: mortar
 * joints, cracks, wood grain and tile gaps all read dark because they catch
 * less ambient light. That holds for surface relief but not for large tonal
 * areas (a painted panel, a lighting gradient), which is why the height map is
 * band-passed rather than taken straight from luma.
 */

export interface PbrOptions {
  reliefStrength: number      // 0..2, default 1
  /** Optional illumination plane from delight(); baked shadow is real AO. */
  illumination?: Float32Array
  /** 0..1 — how much surface variation implies roughness variation. */
  roughnessContrast: number
  /** Base roughness for the material kind. */
  baseRoughness: number
}

export const DEFAULT_PBR: PbrOptions = {
  reliefStrength: 1,
  roughnessContrast: 0.5,
  baseRoughness: 0.6,
}

/** Grain-scale denoise before differencing; anything finer is sensor noise. */
const HEIGHT_FINE_FRACTION = 0.002

/** Low cut. Deliberately generous — at 0.09 of the shorter edge a 1024 tile
 *  still keeps whole brick courses as geometry and only sheds the very slow
 *  gradients. Cutting tighter flattens exactly the relief we are after. */
const HEIGHT_COARSE_BASE = 0.06
const HEIGHT_COARSE_PER_RELIEF = 0.03

/** Sobel gradients on a 0..1 height field are tiny in absolute terms; this maps
 *  reliefStrength 1 onto a normal map with believable, non-flat tilt. */
const NORMAL_GRADIENT_SCALE = 8

/** Cavity radii as fractions of the shorter edge. Three scales because a real
 *  occlusion falloff is not one radius: a hairline crack darkens narrowly, a
 *  deep joint darkens its whole neighbourhood. */
const AO_RADII_FRACTIONS = [0.006, 0.02, 0.05]

/** How hard a unit of "below my neighbours" darkens. Tuned so a full-contrast
 *  mortar line lands around 0.45 rather than crushing to black. */
const AO_GAIN = 2.6

/** Neighbourhood for the local height variance that drives roughness. */
const ROUGHNESS_RADIUS_FRACTION = 0.008

/** Baked lighting is only *partly* occlusion — the illumination plane is a
 *  large-radius low-pass and also carries the sun's direction. Folding half of
 *  it in credits genuine contact shadow without stamping the sun into AO. */
const AO_FROM_ILLUMINATION = 0.5

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Toroidal blur. `blurPlane` clamps at the border, which on a texture meant to
 * tile makes the edge rows reinforce themselves; the band-pass difference then
 * shows up as a bright rim along exactly the seam we are trying to hide.
 * Padding with wrapped copies and cropping afterwards gives a true wrapped
 * blur while still using the one shared kernel.
 */
function blurWrap(plane: Float32Array, width: number, height: number, radius: number): Float32Array {
  const r = Math.max(0, Math.round(radius))
  if (r < 1) return plane.slice()
  const pw = width + r * 2
  const ph = height + r * 2
  const pad = new Float32Array(pw * ph)
  for (let y = 0; y < ph; y++) {
    const srow = ((((y - r) % height) + height) % height) * width
    const drow = y * pw
    for (let x = 0; x < pw; x++) {
      pad[drow + x] = plane[srow + ((((x - r) % width) + width) % width)]
    }
  }
  const blurred = blurPlane(pad, pw, ph, r)
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const from = (y + r) * pw + r
    out.set(blurred.subarray(from, from + width), y * width)
  }
  return out
}

/**
 * Histogram quantiles over the plane's own range — a full sort of a megapixel
 * costs more than the precision is worth here. `qs` must be ascending.
 */
function quantiles(plane: Float32Array, qs: number[]): number[] {
  if (plane.length === 0) return qs.map(() => 0)
  let lo = Infinity
  let hi = -Infinity
  for (let p = 0; p < plane.length; p++) {
    const v = plane[p]
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const span = hi - lo
  if (!(span > 1e-9)) return qs.map(() => lo)

  const bins = 512
  const hist = new Uint32Array(bins)
  const scale = (bins - 1) / span
  for (let p = 0; p < plane.length; p++) {
    hist[clamp(Math.round((plane[p] - lo) * scale), 0, bins - 1) | 0]++
  }

  const out: number[] = []
  let acc = 0
  let b = 0
  for (const q of qs) {
    const target = plane.length * clamp(q, 0, 1)
    while (b < bins - 1 && acc + hist[b] < target) {
      acc += hist[b]
      b++
    }
    out.push(lo + (b / (bins - 1)) * span)
  }
  return out
}

/**
 * Band-passed inverse luma, normalised to 0..1 with 0.5 = flat.
 *
 * `reliefStrength` widens the retained band rather than scaling the amplitude:
 * the height map is a normalised channel that downstream shaders scale
 * themselves, so the meaningful knob here is *how much of the image's
 * structure counts as geometry* — weak relief keeps only fine grain, strong
 * relief promotes larger features like block courses.
 */
export function heightFromAlbedo(albedo: RGBAImage, opts: PbrOptions): Float32Array {
  const { width, height } = albedo
  const n = width * height
  if (n < 1) return new Float32Array(0)

  // Inverted luma is a *depth* signal — dark means recessed, so dark means
  // deep. It gets flipped back into a height at the end.
  const depth = toLumaPlane(albedo)
  for (let p = 0; p < n; p++) depth[p] = 1 - depth[p]

  const short = Math.min(width, height)
  const relief = clamp(opts.reliefStrength, 0, 2)
  // No floor of 1 on the fine radius: on a small map a 1px box already smears a
  // mortar line across three texels, which flattens the very detail the later
  // variance pass is looking for. Small maps are not noisy enough to need it.
  const fine = Math.round(short * HEIGHT_FINE_FRACTION)
  const coarse = Math.max(
    fine + 1,
    Math.round(short * (HEIGHT_COARSE_BASE + HEIGHT_COARSE_PER_RELIEF * relief)),
  )

  const detail = blurWrap(depth, width, height, fine)
  const base = blurWrap(depth, width, height, coarse)
  const band = new Float32Array(n)
  for (let p = 0; p < n; p++) band[p] = detail[p] - base[p]

  // Symmetric window around zero: a band-pass is already zero-mean, so keeping
  // 0.5 as "flat" means a height of 0.5 is meaningful rather than accidental.
  // Percentiles instead of min/max so one dust speck cannot compress the map.
  const [p02, p98] = quantiles(band, [0.02, 0.98])
  const spread = Math.max(Math.abs(p02), Math.abs(p98))
  const out = new Float32Array(n)
  if (!(spread > 1e-6)) {
    out.fill(0.5)
    return out
  }
  // Negated: `band` is depth, the output is height. White has to mean proud of
  // the surface, because normalFromHeight and aoFromHeight both assume the
  // standard convention — get this backwards and mortar joints come out raised
  // and lit while the brick faces sink into shadow.
  const k = 0.5 / spread
  for (let p = 0; p < n; p++) out[p] = clamp(0.5 - band[p] * k, 0, 1)
  return out
}

/**
 * Sobel gradients → tangent-space normal, RGB with the usual 0.5 offset.
 *
 * The neighbour lookups WRAP instead of clamping. The input is a tileable
 * texture: clamping at the border would compute a one-sided gradient there, and
 * that single wrong row/column becomes a hard visible line down the seam of
 * every tiled surface in the level. Wrapping makes the normal map tile as
 * cleanly as the albedo it came from.
 *
 * Image y grows downward, so negating dy yields the green-up (OpenGL) encoding.
 */
export function normalFromHeight(height: Float32Array, w: number, h: number, strength: number): RGBAImage {
  const img = createImage(w, h)
  if (w < 1 || h < 1) return img
  const s = clamp(strength, 0, 2) * NORMAL_GRADIENT_SCALE

  for (let y = 0; y < h; y++) {
    const y0 = ((y - 1) % h + h) % h
    const y1 = ((y + 1) % h + h) % h
    const rowM = y0 * w
    const rowC = y * w
    const rowP = y1 * w
    for (let x = 0; x < w; x++) {
      const x0 = ((x - 1) % w + w) % w
      const x1 = ((x + 1) % w + w) % w

      const tl = height[rowM + x0]
      const tc = height[rowM + x]
      const tr = height[rowM + x1]
      const ml = height[rowC + x0]
      const mr = height[rowC + x1]
      const bl = height[rowP + x0]
      const bc = height[rowP + x]
      const br = height[rowP + x1]

      // /8 turns the Sobel sum back into an average gradient per pixel.
      const dx = ((tr + 2 * mr + br) - (tl + 2 * ml + bl)) / 8
      const dy = ((bl + 2 * bc + br) - (tl + 2 * tc + tr)) / 8

      const nx = -dx * s
      const ny = -dy * s
      const len = Math.hypot(nx, ny, 1)
      const i = (rowC + x) * 4
      img.data[i] = (nx / len) * 127.5 + 127.5
      img.data[i + 1] = (ny / len) * 127.5 + 127.5
      img.data[i + 2] = (1 / len) * 127.5 + 127.5
      img.data[i + 3] = 255
    }
  }
  return img
}

/** Multi-scale cavity occlusion as a 0..1 plane; shared by aoFromHeight and derivePbr. */
function cavityPlane(height: Float32Array, w: number, h: number): Float32Array {
  const n = w * h
  const ao = new Float32Array(n)
  if (n < 1) return ao
  ao.fill(1)

  const short = Math.min(w, h)
  const per = 1 / AO_RADII_FRACTIONS.length
  for (const frac of AO_RADII_FRACTIONS) {
    const around = blurWrap(height, w, h, Math.max(1, Math.round(short * frac)))
    for (let p = 0; p < n; p++) {
      // Only texels *below* their neighbourhood are occluded; a texel sitting
      // proud of the surface is not brightened, it is simply unoccluded.
      const below = around[p] - height[p]
      if (below > 0) ao[p] -= per * clamp(below * AO_GAIN, 0, 1)
    }
  }
  for (let p = 0; p < n; p++) ao[p] = clamp(ao[p], 0, 1)
  return ao
}

/**
 * Cheap cavity AO: compare each texel to a blurred neighbourhood and darken the
 * ones sitting below it. Not a ray-traced solution — there is no real geometry
 * to trace — but it lands the darkening in the right places, which is what the
 * channel is actually for.
 */
export function aoFromHeight(height: Float32Array, w: number, h: number): RGBAImage {
  return fromPlane(cavityPlane(height, w, h), w, h)
}

/**
 * Roughness from local height variance: broken-up surface scatters, flat panel
 * reflects. Centred on `baseRoughness` by normalising the standard deviation
 * against its own median, so the material's identity survives and only the
 * variation around it comes from the photo.
 */
function roughnessPlane(height: Float32Array, w: number, h: number, opts: PbrOptions): Float32Array {
  const n = w * h
  const out = new Float32Array(n)
  const base = clamp(opts.baseRoughness, 0, 1)
  if (n < 1) return out
  out.fill(base)

  const contrast = clamp(opts.roughnessContrast, 0, 1)
  if (contrast <= 0) return out

  const r = Math.max(1, Math.round(Math.min(w, h) * ROUGHNESS_RADIUS_FRACTION))
  const sq = new Float32Array(n)
  for (let p = 0; p < n; p++) sq[p] = height[p] * height[p]
  const mean = blurWrap(height, w, h, r)
  const meanSq = blurWrap(sq, w, h, r)

  const sd = new Float32Array(n)
  for (let p = 0; p < n; p++) {
    // Numerically the two blurs can disagree by an ulp on a flat area, so the
    // variance is floored rather than trusted to be non-negative.
    sd[p] = Math.sqrt(Math.max(0, meanSq[p] - mean[p] * mean[p]))
  }

  const [med, hiQ] = quantiles(sd, [0.5, 0.9])
  const span = hiQ - med
  if (!(span > 1e-6)) return out

  for (let p = 0; p < n; p++) {
    const t = clamp((sd[p] - med) / span, -1, 1)
    out[p] = clamp(base + contrast * 0.5 * t, 0, 1)
  }
  return out
}

/** Derive the full PBR set from a single de-lit albedo. All maps match its size. */
export function derivePbr(albedo: RGBAImage, opts?: Partial<PbrOptions>): PbrMaps {
  const o: PbrOptions = { ...DEFAULT_PBR, ...opts }
  const { width, height } = albedo
  const n = width * height

  const heightPlane = heightFromAlbedo(albedo, o)
  const ao = cavityPlane(heightPlane, width, height)

  // A shadow that was baked into the photograph marks a genuinely occluded
  // area, and the cavity pass cannot see it — it only knows the relief it
  // inferred. Damped rather than multiplied outright; see AO_FROM_ILLUMINATION.
  const illum = o.illumination
  if (illum && illum.length === n) {
    for (let p = 0; p < n; p++) {
      ao[p] = clamp(ao[p] * (1 - AO_FROM_ILLUMINATION * (1 - clamp(illum[p], 0, 1))), 0, 1)
    }
  }

  return {
    albedo: cloneImage(albedo),
    normal: normalFromHeight(heightPlane, width, height, o.reliefStrength),
    roughness: fromPlane(roughnessPlane(heightPlane, width, height, o), width, height),
    ao: fromPlane(ao, width, height),
    height: fromPlane(heightPlane, width, height),
  }
}
