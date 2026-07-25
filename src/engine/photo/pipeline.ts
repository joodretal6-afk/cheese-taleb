import {
  type MaterialKind,
  type PbrMaps,
  type PhotoRegion,
  type ProcessOptions,
  type Quad,
  type RGBAImage,
  DEFAULT_PROCESS,
  createImage,
  toDataURL,
} from './types'
import { rectify, suggestAspect } from './rectify'
import { autoWhiteBalance, delight } from './delight'
import { makeTileable, tilingScore } from './tileable'
import { derivePbr, type PbrOptions } from './pbr'

/**
 * The whole photo → game-material pipeline, in one place.
 *
 * Fixed order, and the order is the point:
 *
 *   rectify → white balance → delight → tileable → derivePbr
 *
 * Rectify first because every later stage measures radii as a fraction of the
 * image, and those fractions only mean anything once the surface is flat and at
 * its final resolution. White balance before delight because delight works on
 * luma and a strong colour cast biases what it thinks the lighting is. Tiling
 * after delight because the offset-blend cannot hide a tonal step that de-lighting
 * would have removed anyway. PBR last because every map is derived from the
 * finished albedo.
 *
 * Nothing here throws for a recoverable problem. A stage that fails hands its
 * input through unchanged and adds a warning the user can read — half a material
 * is far more useful than an exception in the middle of a batch of eight.
 */

export interface MaterialResult {
  id: string
  label: string
  kind: MaterialKind
  maps: PbrMaps
  /** Data URLs for the UI, same keys as PbrMaps. */
  previews: Record<keyof PbrMaps, string>
  /** 0..1 seam quality; low means the source photo tiles badly. */
  tilingScore: number
  /** How many metres one tile covers, from ProcessOptions.realWorldWidthM. */
  tileMetres: number
  warnings: string[]
}

export interface ProgressUpdate {
  stage: string
  fraction: number
}

// ------------------------------------------------------------- per-kind setup

/** Everything a kind implies that ProcessOptions has no field for. */
interface KindTuning {
  /** Cross-fade width handed to makeTileable, fraction of the image. */
  blend: number
  /** Roughness the material sits at before the photo modulates it. */
  baseRoughness: number
  /** How far the photo is allowed to push roughness around that base. */
  roughnessContrast: number
}

/**
 * Per-kind processing defaults. These are judgements, not arbitrary numbers:
 *
 *  - A door or a window is a single object, not a repeating surface. Tiling it
 *    would fold its own frame back over the middle of the leaf, so tileable is
 *    off and the relief is kept low — the panel mouldings are real geometry the
 *    modeller builds, and a normal map that also fakes them reads doubled.
 *  - A wall repeats and wants medium relief: enough for block courses and mortar
 *    to catch a grazing light, not so much that flat render turns into stucco.
 *  - Ground repeats, wants the strongest relief in the set (gravel, ruts and
 *    cracks are the whole reason a ground material is interesting) and covers a
 *    much larger real-world span, because a floor tile repeating every two metres
 *    is the classic giveaway of a photo-sourced texture.
 *  - Metal is smooth: a low base roughness and little contrast, otherwise the
 *    dirt in the photograph turns a gate into sandpaper. Its delight strength is
 *    also pulled down, because a specular highlight on metal is not "lighting the
 *    homomorphic filter can divide out" — it is a mirror image of the sky, and
 *    pushing hard at it only carves a grey hole where the highlight was.
 *  - Fabric is the opposite: rough everywhere, with weave detail worth keeping.
 */
const KIND_PROCESS: Record<MaterialKind, Partial<ProcessOptions>> = {
  wall: { tileable: true, reliefStrength: 0.6, delightStrength: 0.85, realWorldWidthM: 3 },
  door: { tileable: false, reliefStrength: 0.3, delightStrength: 0.7, realWorldWidthM: 1 },
  window: { tileable: false, reliefStrength: 0.25, delightStrength: 0.5, realWorldWidthM: 1.2 },
  ground: { tileable: true, reliefStrength: 1, delightStrength: 0.85, realWorldWidthM: 4 },
  rock: { tileable: true, reliefStrength: 1, delightStrength: 0.8, realWorldWidthM: 2.5 },
  wood: { tileable: true, reliefStrength: 0.7, delightStrength: 0.75, realWorldWidthM: 1.5 },
  metal: { tileable: true, reliefStrength: 0.35, delightStrength: 0.5, realWorldWidthM: 1.5 },
  fabric: { tileable: true, reliefStrength: 0.5, delightStrength: 0.7, realWorldWidthM: 1 },
  unknown: {},
}

const KIND_TUNING: Record<MaterialKind, KindTuning> = {
  wall: { blend: 0.12, baseRoughness: 0.75, roughnessContrast: 0.5 },
  door: { blend: 0.12, baseRoughness: 0.55, roughnessContrast: 0.35 },
  window: { blend: 0.12, baseRoughness: 0.2, roughnessContrast: 0.2 },
  // Wide blends on the two noisy, structureless materials: there is nothing with
  // a straight line to ghost, and a wider fade buries the seam deeper.
  ground: { blend: 0.18, baseRoughness: 0.9, roughnessContrast: 0.6 },
  rock: { blend: 0.18, baseRoughness: 0.85, roughnessContrast: 0.6 },
  // Grain and planks are strong parallel lines; a wide cross-fade doubles them.
  wood: { blend: 0.08, baseRoughness: 0.6, roughnessContrast: 0.45 },
  metal: { blend: 0.08, baseRoughness: 0.3, roughnessContrast: 0.25 },
  fabric: { blend: 0.14, baseRoughness: 0.9, roughnessContrast: 0.4 },
  unknown: { blend: 0.12, baseRoughness: 0.6, roughnessContrast: 0.5 },
}

/**
 * Processing defaults for a material kind, meant to be merged under the user's
 * own overrides. Only covers fields ProcessOptions has; roughness and seam blend
 * are kind-specific too but live in KIND_TUNING, since the caller cannot pass them.
 */
export function defaultsForKind(kind: MaterialKind): Partial<ProcessOptions> {
  return { ...(KIND_PROCESS[kind] ?? {}) }
}

// -------------------------------------------------------------------- helpers

/** Preview edge cap. A 4096² map is ~90 MB of base64 as a PNG data URL, and five
 *  of those per material will take the tab down long before the user sees them.
 *  Previews are for looking at; the full-resolution buffers stay in `maps`. */
const PREVIEW_MAX = 512

/** Below this the wrap is a visible join on most surfaces. */
const TILING_WARN = 0.6

/** Aspect beyond which a quad is more likely mis-placed corners than a real
 *  surface, and beyond which a square tile visibly stretches. */
const ASPECT_EXTREME = 3.5
const ASPECT_STRETCH = 2

/** How much of the baked lighting survives into AO once the texture tiles. A
 *  tiled material repeats its AO across the whole wall, so a full-strength sun
 *  gradient becomes a regular grid of dark patches — exactly the artefact tiling
 *  is supposed to remove. Halved, it still credits contact shadow. */
const TILED_ILLUMINATION_DAMP = 0.5

const MAP_KEYS: (keyof PbrMaps)[] = ['albedo', 'normal', 'roughness', 'ao', 'height']

const SIZES: ProcessOptions['size'][] = [512, 1024, 2048, 4096, 8192]

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function smoothstep01(t: number): number {
  const u = clamp(t, 0, 1)
  return u * u * (3 - 2 * u)
}

/**
 * Hand the event loop back between stages.
 *
 * Every stage is a synchronous pass over a multi-megapixel buffer. Run
 * back-to-back they are one long task, during which the browser cannot repaint —
 * so the progress bar we are carefully feeding would only ever render once, at
 * 100%, after the freeze the user already noticed. A macrotask (setTimeout 0)
 * rather than a microtask: an awaited resolved promise is drained inside the
 * same task and yields nothing to the compositor.
 *
 * This does not make the pipeline concurrent — a 4K image still blocks for as
 * long as each individual stage takes. Moving the whole thing into a worker is
 * the real fix; this is what keeps it bearable on the main thread meanwhile.
 */
function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function makeReporter(onProgress?: (u: ProgressUpdate) => void): (stage: string, fraction: number) => void {
  return (stage, fraction) => {
    if (!onProgress) return
    // A throwing progress callback is the UI's bug, not a reason to lose the
    // material the user has already waited a minute for.
    try {
      onProgress({ stage, fraction: clamp(fraction, 0, 1) })
    } catch (err) {
      console.warn('[pipeline] progress callback threw', err)
    }
  }
}

function attempt<T>(work: () => T, fallback: T, warnings: string[], message: string): T {
  try {
    return work()
  } catch (err) {
    console.warn('[pipeline]', message, err)
    warnings.push(message)
    return fallback
  }
}

function num(value: number | undefined, fallback: number, lo: number, hi: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, lo, hi) : fallback
}

/** Nearest allowed output size; anything unrecognised snaps rather than throws. */
function normaliseSize(value: number | undefined): ProcessOptions['size'] {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PROCESS.size
  let best = SIZES[0]
  let bestD = Infinity
  for (const s of SIZES) {
    const d = Math.abs(Math.log2(s) - Math.log2(Math.max(1, value)))
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  return best
}

function resolveOptions(kind: MaterialKind, overrides?: Partial<ProcessOptions>): ProcessOptions {
  const base: ProcessOptions = { ...DEFAULT_PROCESS, ...defaultsForKind(kind) }
  const o = overrides ?? {}
  return {
    size: normaliseSize(o.size ?? base.size),
    delightStrength: num(o.delightStrength, base.delightStrength, 0, 1),
    tileable: typeof o.tileable === 'boolean' ? o.tileable : base.tileable,
    // ProcessOptions documents 0..1, but derivePbr accepts up to 2 — clamped to
    // the wider range so an advanced user can push past our own defaults, which
    // deliberately stay inside the documented band.
    reliefStrength: num(o.reliefStrength, base.reliefStrength, 0, 2),
    realWorldWidthM: num(o.realWorldWidthM, base.realWorldWidthM, 0.05, 200),
  }
}

function isFiniteQuad(quad: Quad): boolean {
  for (const p of quad) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false
  }
  return true
}

function wholeFrame(img: RGBAImage): Quad {
  return [
    { x: 0, y: 0 },
    { x: img.width, y: 0 },
    { x: img.width, y: img.height },
    { x: 0, y: img.height },
  ]
}

/**
 * Source pixels the quad actually covers, as an average of its opposite edges.
 *
 * Under perspective the near edge is longer than the far one and averaging
 * splits the difference — which is the conservative reading for "did this photo
 * carry enough detail", since the far half is genuinely the resolution the
 * rectified texture inherits over that part of the surface.
 */
function quadExtent(quad: Quad): { w: number; h: number } {
  const [tl, tr, br, bl] = quad
  return {
    w: (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2,
    h: (Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y)) / 2,
  }
}

function pow2(v: number): number {
  return 2 ** Math.round(Math.log2(Math.max(1, v)))
}

/**
 * Output raster for the material.
 *
 * A tile is square on purpose: the renderer repeats it at one scale derived from
 * `tileMetres`, and a non-square tile would need a second scale nobody carries
 * through. A non-square *region* therefore gets stretched into that square,
 * which is what the aspect warning is for. A one-off (a door) keeps its shape,
 * with both edges snapped to powers of two so mipmapping stays happy.
 */
function outputDims(size: number, aspect: number, tileable: boolean): { w: number; h: number } {
  if (tileable) return { w: size, h: size }
  const short = clamp(pow2(size / Math.max(aspect, 1 / aspect)), 64, size)
  return aspect >= 1 ? { w: size, h: short } : { w: short, h: size }
}

/**
 * One axis of the half-offset cross-fade, mirroring `offsetBlendAxis` in
 * tileable.ts for a float plane.
 *
 * It has to mirror it exactly. `makeTileable` moves pixels — everything past the
 * midpoint of the blend band comes from half an image away — so the illumination
 * plane delight measured on the *un*-tiled albedo no longer lines up with it. Fed
 * to derivePbr as-is, a shadow at the top of the photo would darken AO across the
 * middle of the tile instead. Running the plane through the same transform keeps
 * the two registered, and as a bonus makes the AO contribution wrap as cleanly
 * as the albedo does.
 */
function blendPlaneAxis(src: Float32Array, w: number, h: number, blend: number, vertical: boolean): Float32Array {
  const n = vertical ? h : w
  const half = n >> 1
  if (n < 4) return src.slice()

  const band = Math.min(clamp(blend, 0, 1) * n * 0.5, half - 0.5)
  const weight = new Float32Array(n)
  if (band > 0) {
    for (let i = 0; i < n; i++) {
      weight[i] = 0.5 * (1 - smoothstep01(Math.abs(i + 0.5 - half) / band))
    }
  }

  const out = new Float32Array(src.length)
  for (let y = 0; y < h; y++) {
    const sy = vertical ? (y + half) % h : y
    for (let x = 0; x < w; x++) {
      const a = weight[vertical ? y : x]
      const sx = vertical ? x : (x + half) % w
      out[y * w + x] = src[sy * w + sx] * (1 - a) + src[y * w + x] * a
    }
  }
  return out
}

/** Illumination plane brought into register with a tiled albedo, and damped. */
function tileIllumination(plane: Float32Array, w: number, h: number, blend: number): Float32Array {
  const moved = blendPlaneAxis(blendPlaneAxis(plane, w, h, blend, false), w, h, blend, true)
  for (let p = 0; p < moved.length; p++) {
    moved[p] = 1 - (1 - clamp(moved[p], 0, 1)) * TILED_ILLUMINATION_DAMP
  }
  return moved
}

/** Box-average downscale. Only ever used on previews, so speed beats a lanczos. */
function downscale(img: RGBAImage, max: number): RGBAImage {
  const long = Math.max(img.width, img.height)
  if (long <= max || long < 1) return img
  const k = max / long
  const tw = Math.max(1, Math.round(img.width * k))
  const th = Math.max(1, Math.round(img.height * k))
  const out = createImage(tw, th)
  const fx = img.width / tw
  const fy = img.height / th

  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * fy)
    const y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) * fy)))
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * fx)
      const x1 = Math.max(x0 + 1, Math.min(img.width, Math.floor((x + 1) * fx)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * img.width + x0) * 4
        for (let sx = x0; sx < x1; sx++, i += 4) {
          r += img.data[i]
          g += img.data[i + 1]
          b += img.data[i + 2]
          a += img.data[i + 3]
          n++
        }
      }
      const o = (y * tw + x) * 4
      if (n > 0) {
        out.data[o] = r / n
        out.data[o + 1] = g / n
        out.data[o + 2] = b / n
        out.data[o + 3] = a / n
      }
    }
  }
  return out
}

/**
 * Data URLs for the UI. Empty strings — never an error — when there is no DOM:
 * `toDataURL` needs a canvas, and this pipeline is meant to run in a worker and
 * in Node tests too. A missing thumbnail is not something to warn the user about
 * in a context where there is no user looking.
 */
let previewsUnavailable = false

function makePreviews(maps: PbrMaps): Record<keyof PbrMaps, string> {
  const out: Record<keyof PbrMaps, string> = { albedo: '', normal: '', roughness: '', ao: '', height: '' }
  for (const key of MAP_KEYS) {
    try {
      out[key] = toDataURL(downscale(maps[key], PREVIEW_MAX))
    } catch (err) {
      // Reported once per process: whatever made the first encode fail is an
      // environment fact, and a batch of eight regions would log it forty times.
      if (!previewsUnavailable) {
        previewsUnavailable = true
        console.warn('[pipeline] preview encoding unavailable in this environment', err)
      }
      break
    }
  }
  return out
}

function emptyMaps(w: number, h: number): PbrMaps {
  return {
    albedo: createImage(w, h),
    normal: createImage(w, h),
    roughness: createImage(w, h),
    ao: createImage(w, h),
    height: createImage(w, h),
  }
}

// ------------------------------------------------------------------- pipeline

/**
 * Turn one region of a photo into one game material.
 *
 * Resolves against DEFAULT_PROCESS, then the region kind's defaults, then the
 * caller's overrides — so passing `{}` still gets sensible per-kind behaviour
 * while an explicit `tileable: false` always wins.
 */
export async function processPhoto(
  img: RGBAImage,
  region: PhotoRegion,
  options?: Partial<ProcessOptions>,
  onProgress?: (u: ProgressUpdate) => void,
): Promise<MaterialResult> {
  const warnings: string[] = []
  const report = makeReporter(onProgress)
  const kind: MaterialKind = region.kind ?? 'unknown'
  const opts = resolveOptions(kind, options)
  const tuning = KIND_TUNING[kind] ?? KIND_TUNING.unknown

  let quad = region.quad
  if (!Array.isArray(quad) || quad.length !== 4 || !isFiniteQuad(quad)) {
    warnings.push('زوايا المنطقة غير صالحة، فاستُخدم إطار الصورة كاملاً بدلاً منها.')
    quad = wholeFrame(img)
  }

  const aspect = attempt(() => suggestAspect(quad), 1, warnings, 'تعذّر حساب نسبة أبعاد المنطقة، فاعتُمدت نسبة مربعة.')
  const { w, h } = outputDims(opts.size, aspect, opts.tileable)

  if (img.width < 1 || img.height < 1) {
    warnings.push('الصورة المصدر فارغة، فلا يمكن اشتقاق مادة منها.')
    return {
      id: region.id,
      label: region.label,
      kind,
      maps: emptyMaps(w, h),
      previews: { albedo: '', normal: '', roughness: '', ao: '', height: '' },
      tilingScore: 0,
      tileMetres: opts.realWorldWidthM,
      warnings,
    }
  }

  // --- resolution honesty, before any work: the user can still cancel.
  const extent = quadExtent(quad)
  if (extent.w < w * 0.9 || extent.h < h * 0.9) {
    warnings.push(
      `دقة المصدر داخل المنطقة (${Math.round(extent.w)}×${Math.round(extent.h)} بكسل) أقل من حجم الإخراج ` +
        `(${w}×${h}). سيجري تكبير الصورة، والتكبير يخترع تفاصيل غير موجودة أصلاً.`,
    )
  }
  const extremeAspect = aspect >= ASPECT_EXTREME || aspect <= 1 / ASPECT_EXTREME
  if (extremeAspect) {
    const ratio = aspect >= 1 ? `${aspect.toFixed(1)}:1` : `1:${(1 / aspect).toFixed(1)}`
    warnings.push(`نسبة أبعاد المنطقة متطرفة (${ratio}). تأكّد من مواضع الزوايا الأربع قبل الاعتماد على النتيجة.`)
  }
  if (opts.tileable && !extremeAspect && (aspect >= ASPECT_STRETCH || aspect <= 1 / ASPECT_STRETCH)) {
    warnings.push('المنطقة بعيدة عن الشكل المربع، وسيجري تحويلها إلى نسيج مربع متكرر فتبدو التفاصيل ممتدة في اتجاه واحد.')
  }

  report('تصحيح المنظور', 0)
  const flat = attempt(
    () => rectify(img, quad, w, h),
    createImage(w, h),
    warnings,
    'تعذّر تصحيح المنظور، فاستُخدمت المنطقة كما هي.',
  )
  await yieldToUI()

  report('موازنة الأبيض', 0.15)
  const balanced = attempt(
    () => autoWhiteBalance(flat),
    flat,
    warnings,
    'تعذّرت موازنة الأبيض، فبقيت ألوان الصورة كما التقطتها الكاميرا.',
  )
  await yieldToUI()

  report('إزالة الإضاءة المدمجة', 0.25)
  const lit = attempt(
    () => delight(balanced, opts.delightStrength),
    { albedo: balanced, illumination: new Float32Array(0) },
    warnings,
    'تعذّرت إزالة الإضاءة المدمجة، وقد تبقى ظلال الصورة الأصلية في اللون الأساسي.',
  )
  await yieldToUI()

  // The illumination plane is only usable as an AO prior while it still lines up
  // with the albedo, which the tiling stage below is about to change.
  let albedo = lit.albedo
  let illumination: Float32Array | undefined =
    lit.illumination.length === w * h ? lit.illumination : undefined

  if (opts.tileable) {
    report('تجهيز التكرار بلا حواف', 0.5)
    const tiled = attempt(
      () => makeTileable(albedo, tuning.blend),
      albedo,
      warnings,
      'تعذّر تجهيز النسيج للتكرار، وقد يظهر خط عند حدود التكرار.',
    )
    const plane = illumination
    if (tiled !== albedo && plane) {
      illumination = attempt<Float32Array | undefined>(
        () => tileIllumination(plane, w, h, tuning.blend),
        undefined,
        warnings,
        'تعذّرت مطابقة خريطة الإضاءة مع النسيج المتكرر، فلم تُدمج الظلال في خريطة الانحجاب.',
      )
    }
    albedo = tiled
    await yieldToUI()
  }

  report('اشتقاق خرائط PBR', 0.65)
  const pbrOpts: Partial<PbrOptions> = {
    reliefStrength: opts.reliefStrength,
    baseRoughness: tuning.baseRoughness,
    roughnessContrast: tuning.roughnessContrast,
    illumination,
  }
  const maps = attempt(
    () => derivePbr(albedo, pbrOpts),
    { ...emptyMaps(albedo.width, albedo.height), albedo },
    warnings,
    'تعذّر اشتقاق خرائط PBR، وسلّمت المادة باللون الأساسي فقط.',
  )
  await yieldToUI()

  // Scored on what actually ships. For a non-tileable material the number is
  // reported but not warned about — nobody repeats a door.
  const seam = attempt(() => tilingScore(maps.albedo), 0, warnings, 'تعذّر قياس جودة حواف التكرار.')
  if (opts.tileable && seam < TILING_WARN) {
    warnings.push(
      `جودة حواف التكرار منخفضة (${Math.round(seam * 100)}٪): الصورة الأصلية لا تتكرر بسلاسة. ` +
        'جرّب تحديد منطقة أكثر تجانساً، أو أوقف خيار التكرار.',
    )
  }

  report('تجهيز المعاينات', 0.9)
  const previews = makePreviews(maps)
  report('اكتمل', 1)

  return {
    id: region.id,
    label: region.label,
    kind,
    maps,
    previews,
    tilingScore: seam,
    tileMetres: opts.realWorldWidthM,
    warnings,
  }
}

/**
 * Every region of one photo, in order.
 *
 * Sequential rather than parallel on purpose: these stages are CPU-bound and
 * single-threaded, so interleaving them would only make each finish later while
 * holding several full-resolution intermediates alive at once — the fastest way
 * to run a phone out of memory on a 12MP photo.
 */
export async function processPhotoAll(
  img: RGBAImage,
  regions: PhotoRegion[],
  options?: Partial<ProcessOptions>,
  onProgress?: (u: ProgressUpdate) => void,
): Promise<MaterialResult[]> {
  const report = makeReporter(onProgress)
  const list = Array.isArray(regions) ? regions.filter((r) => r && Array.isArray(r.quad)) : []
  if (list.length === 0) {
    report('اكتمل', 1)
    return []
  }

  const out: MaterialResult[] = []
  for (let i = 0; i < list.length; i++) {
    const region = list[i]
    // Sub-progress is remapped into this region's slice of the whole batch, and
    // the region's own label is carried through so the bar can say which surface
    // it is on — with eight regions the stage name alone tells the user nothing.
    const result = await processPhoto(img, region, options, (u) => {
      report(`${region.label} — ${u.stage}`, (i + u.fraction) / list.length)
    })
    out.push(result)
  }

  report('اكتمل', 1)
  return out
}
