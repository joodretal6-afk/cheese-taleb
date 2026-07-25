/**
 * Scene segmentation — cutting one photo of a yard, a street or a house front
 * into the separate surfaces (wall, ground, gate, door, sky) that each become
 * their own material.
 *
 * IMPORTANT, and the reason every threshold below is documented rather than
 * hidden: the local path is a *starting point*, not a mask. It quantises colour
 * and grows connected blobs, so what comes back are rough axis-aligned boxes
 * around the dominant colour areas — a shadow, a parked car or a bush will
 * happily become its own "region", and a wall split by a downpipe becomes two.
 * The UI must hand every returned quad to the user with draggable corners; the
 * expectation is that they nudge them. Production-quality masks come from
 * `segmentRemote`, i.e. a real SAM/Segment-Anything service. The local pass
 * exists so the tool still works offline, on a phone, with no key and no
 * latency — never because it is as good.
 *
 * Like the rest of the pipeline this is plain arithmetic over plain data, so it
 * runs in a worker and is testable in Node.
 */

import {
  type MaterialKind,
  type PhotoRegion,
  type Quad,
  type RGBAImage,
  getPixel,
  luma,
  toDataURL,
} from './types'

export interface SegmentOptions {
  /** Upper bound on returned regions. More than a handful is not editable by hand. */
  maxRegions: number
  /** Regions covering less of the frame than this are noise, not surfaces. */
  minAreaFraction: number
}

export const DEFAULT_SEGMENT: SegmentOptions = {
  maxRegions: 8,
  minAreaFraction: 0.02,
}

/** Long edge the clustering pass works on. Small on purpose: we want the
 *  scene's surfaces, not the grain of the plaster. */
const WORK_MAX_DIM = 256
/** Palette size. Six covers sky / wall / ground / door / shadow / one accent,
 *  which is about what a single yard photo contains. */
const PALETTE_K = 6
/** Lloyd iterations. Convergence on 64k pixels is usually reached by ~8. */
const KMEANS_ITERS = 14
/** Levels per channel in the seeding histogram: 8^3 = 512 colour bins. */
const SEED_LEVELS = 8
/** Samples along the longer edge when measuring a region's colour statistics. */
const CLASSIFY_GRID = 48

const KIND_LABELS: Record<MaterialKind, string> = {
  wall: 'جدار',
  door: 'باب',
  window: 'نافذة',
  ground: 'أرض',
  rock: 'صخر',
  wood: 'خشب',
  metal: 'معدن',
  fabric: 'قماش',
  unknown: 'منطقة',
}

const MATERIAL_KINDS = Object.keys(KIND_LABELS) as MaterialKind[]

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// ------------------------------------------------------------- colour pass

/**
 * Box-average the photo down to a small RGB plane, three floats per pixel.
 *
 * Box rather than nearest-neighbour: clustering has to see the average colour
 * of a surface, otherwise a single mortar joint or gravel chip that a
 * nearest tap landed on decides which cluster a whole wall belongs to.
 */
function downscaleRGB(img: RGBAImage, tw: number, th: number): Float32Array {
  const out = new Float32Array(tw * th * 3)
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
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * img.width + x0) * 4
        for (let sx = x0; sx < x1; sx++, i += 4) {
          r += img.data[i]
          g += img.data[i + 1]
          b += img.data[i + 2]
          n++
        }
      }
      const p = (y * tw + x) * 3
      if (n > 0) {
        out[p] = r / n
        out[p + 1] = g / n
        out[p + 2] = b / n
      }
    }
  }
  return out
}

/**
 * Initial palette, chosen from a coarse colour histogram: take the most
 * populated bins first, but refuse a bin that sits within `sep` of a centroid
 * already taken, relaxing `sep` until we have enough.
 *
 * This replaces k-means++'s random seeding for one reason — the user must get
 * the same regions every time they open the same photo, or dragging a corner
 * and re-running would reshuffle everything under their hands. Population
 * ordering (ties broken by bin index) is fully deterministic, and unlike
 * farthest-point seeding it cannot be hijacked by one bright outlier pixel.
 */
function seedCentroids(px: Float32Array, k: number): Float64Array {
  const bins = SEED_LEVELS * SEED_LEVELS * SEED_LEVELS
  const count = new Uint32Array(bins)
  const sum = new Float64Array(bins * 3)
  const q = (v: number): number => clamp((v * SEED_LEVELS) / 256, 0, SEED_LEVELS - 1) | 0

  for (let i = 0; i < px.length; i += 3) {
    const bi = (q(px[i]) * SEED_LEVELS + q(px[i + 1])) * SEED_LEVELS + q(px[i + 2])
    count[bi]++
    sum[bi * 3] += px[i]
    sum[bi * 3 + 1] += px[i + 1]
    sum[bi * 3 + 2] += px[i + 2]
  }

  const order: number[] = []
  for (let bi = 0; bi < bins; bi++) if (count[bi] > 0) order.push(bi)
  order.sort((a, b) => count[b] - count[a] || a - b)

  const taken = new Uint8Array(bins)
  const chosen: number[] = []
  // Last pass has sep 0, so we always end up with min(k, distinct bins) seeds.
  for (const sep of [112, 56, 28, 0]) {
    const sq = sep * sep
    for (const bi of order) {
      if (chosen.length >= k * 3) break
      if (taken[bi]) continue
      const cr = sum[bi * 3] / count[bi]
      const cg = sum[bi * 3 + 1] / count[bi]
      const cb = sum[bi * 3 + 2] / count[bi]
      let ok = true
      for (let c = 0; c < chosen.length; c += 3) {
        const dr = cr - chosen[c]
        const dg = cg - chosen[c + 1]
        const db = cb - chosen[c + 2]
        if (dr * dr + dg * dg + db * db < sq) {
          ok = false
          break
        }
      }
      if (!ok) continue
      taken[bi] = 1
      chosen.push(cr, cg, cb)
    }
    if (chosen.length >= k * 3) break
  }
  return Float64Array.from(chosen)
}

/**
 * Lloyd's algorithm in plain RGB. Returns one palette index per pixel.
 *
 * Plain RGB, not a perceptual space: the goal here is "which pixels belong to
 * the same painted surface", and for that the extra accuracy of Lab does not
 * change which blobs come out, while the conversion would cost a pass over
 * every pixel.
 */
function kmeans(px: Float32Array, k: number): { labels: Uint8Array; k: number } {
  const n = px.length / 3
  const cent = seedCentroids(px, k)
  const kk = cent.length / 3
  const labels = new Uint8Array(n)
  if (kk === 0) return { labels, k: 1 }

  const sums = new Float64Array(kk * 3)
  const counts = new Uint32Array(kk)
  for (let it = 0; it < KMEANS_ITERS; it++) {
    sums.fill(0)
    counts.fill(0)
    let changed = 0
    for (let p = 0, i = 0; p < n; p++, i += 3) {
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < kk; c++) {
        const dr = px[i] - cent[c * 3]
        const dg = px[i + 1] - cent[c * 3 + 1]
        const db = px[i + 2] - cent[c * 3 + 2]
        const d = dr * dr + dg * dg + db * db
        // Strict `<` leaves ties with the lowest centroid index — another piece
        // of the determinism guarantee.
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      if (labels[p] !== best) changed++
      labels[p] = best
      counts[best]++
      sums[best * 3] += px[i]
      sums[best * 3 + 1] += px[i + 1]
      sums[best * 3 + 2] += px[i + 2]
    }
    for (let c = 0; c < kk; c++) {
      // An emptied cluster keeps its old centre rather than being reseeded:
      // reseeding is where non-determinism usually creeps back in, and a stale
      // centroid simply stays unused.
      if (counts[c] === 0) continue
      cent[c * 3] = sums[c * 3] / counts[c]
      cent[c * 3 + 1] = sums[c * 3 + 1] / counts[c]
      cent[c * 3 + 2] = sums[c * 3 + 2] / counts[c]
    }
    if (changed === 0) break
  }
  return { labels, k: kk }
}

/**
 * 3x3 mode filter over the palette indices. Quantisation alone leaves a fringe
 * of single-pixel speckle along every colour boundary, and each speck would
 * otherwise be labelled as its own component, inflating the component count by
 * orders of magnitude before the area filter ever runs.
 */
function despeckle(labels: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const out = new Uint8Array(labels.length)
  const tally = new Uint16Array(k)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      tally.fill(0)
      for (let dy = -1; dy <= 1; dy++) {
        const yy = clamp(y + dy, 0, h - 1)
        for (let dx = -1; dx <= 1; dx++) {
          tally[labels[yy * w + clamp(x + dx, 0, w - 1)]]++
        }
      }
      // The incumbent label wins ties, so flat areas never oscillate.
      let best = labels[y * w + x]
      let bestN = tally[best]
      for (let c = 0; c < k; c++) {
        if (tally[c] > bestN) {
          bestN = tally[c]
          best = c
        }
      }
      out[y * w + x] = best
    }
  }
  return out
}

// --------------------------------------------------------- components

interface Component {
  area: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * 4-connected labelling with an explicit stack — a recursive flood fill blows
 * the JS stack on a sky that covers half a 256x256 plane.
 */
function connectedComponents(labels: Uint8Array, w: number, h: number, minArea: number): Component[] {
  const seen = new Uint8Array(labels.length)
  const stack = new Int32Array(labels.length)
  const out: Component[] = []

  for (let start = 0; start < labels.length; start++) {
    if (seen[start]) continue
    const target = labels[start]
    let sp = 0
    stack[sp++] = start
    seen[start] = 1
    let area = 0
    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1

    while (sp > 0) {
      const i = stack[--sp]
      const x = i % w
      const y = (i / w) | 0
      area++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y

      if (x > 0 && !seen[i - 1] && labels[i - 1] === target) {
        seen[i - 1] = 1
        stack[sp++] = i - 1
      }
      if (x + 1 < w && !seen[i + 1] && labels[i + 1] === target) {
        seen[i + 1] = 1
        stack[sp++] = i + 1
      }
      if (y > 0 && !seen[i - w] && labels[i - w] === target) {
        seen[i - w] = 1
        stack[sp++] = i - w
      }
      if (y + 1 < h && !seen[i + w] && labels[i + w] === target) {
        seen[i + w] = 1
        stack[sp++] = i + w
      }
    }

    if (area >= minArea) out.push({ area, minX, minY, maxX, maxY })
  }

  // Area descending, ties by position, so the ordering is stable for identical
  // inputs regardless of how the labelling scan happened to run.
  out.sort((a, b) => b.area - a.area || a.minY - b.minY || a.minX - b.minX)
  return out
}

/**
 * Component bounding box in the work plane back to full-resolution corners.
 * Work pixel i covers source pixels [i*s, (i+1)*s), hence the +1 on the far
 * edges — dropping it would shave a whole work-pixel off the right and bottom
 * of every region, which at a 20x downscale is a visible slice of wall.
 */
function boxToQuad(c: Component, sx: number, sy: number, w: number, h: number): Quad {
  const x0 = clamp(c.minX * sx, 0, w)
  const x1 = clamp((c.maxX + 1) * sx, 0, w)
  const y0 = clamp(c.minY * sy, 0, h)
  const y1 = clamp((c.maxY + 1) * sy, 0, h)
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]
}

// ------------------------------------------------------------ classification

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  cx: number
  cy: number
}

function quadBounds(q: Quad): Bounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let sx = 0
  let sy = 0
  for (const p of q) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
    sx += p.x
    sy += p.y
  }
  return { minX, minY, maxX, maxY, cx: sx / 4, cy: sy / 4 }
}

/** Even-odd crossing test. Works for any simple quad, including the tilted ones
 *  the user drags out by hand — a bounding-box test would sample the neighbours. */
function pointInQuad(q: Quad, x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = q[i]
    const b = q[j]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

interface RegionStats {
  samples: number
  /** Mean luma, 0..255. */
  lum: number
  r: number
  g: number
  b: number
  /** Mean HSV-style saturation, 0..1. */
  saturation: number
  /** Mean (blue - average of red and green) / 255. Positive means blue-cast. */
  blueness: number
  /** Standard deviation of luma / 255 — the "is it busy" number. */
  texture: number
}

function sampleRegion(img: RGBAImage, quad: Quad, b: Bounds): RegionStats {
  const stats: RegionStats = { samples: 0, lum: 0, r: 0, g: 0, b: 0, saturation: 0, blueness: 0, texture: 0 }
  const bw = b.maxX - b.minX
  const bh = b.maxY - b.minY
  if (!(bw > 0) || !(bh > 0)) return stats

  const step = Math.max(1, Math.ceil(Math.max(bw, bh) / CLASSIFY_GRID))
  const px: number[] = [0, 0, 0, 0]
  let sumL = 0
  let sumL2 = 0
  let sumSat = 0
  let satN = 0
  let n = 0

  for (let y = Math.floor(b.minY); y < b.maxY; y += step) {
    for (let x = Math.floor(b.minX); x < b.maxX; x += step) {
      if (!pointInQuad(quad, x + 0.5, y + 0.5)) continue
      getPixel(img, x, y, px)
      const l = luma(px[0], px[1], px[2])
      sumL += l
      sumL2 += l * l
      stats.r += px[0]
      stats.g += px[1]
      stats.b += px[2]
      stats.blueness += px[2] - (px[0] + px[1]) / 2
      const hi = Math.max(px[0], px[1], px[2])
      // Near-black carries no usable chroma; averaging its saturation in would
      // just report every night photo as grey.
      if (hi >= 8) {
        sumSat += (hi - Math.min(px[0], px[1], px[2])) / hi
        satN++
      }
      n++
    }
  }
  if (n === 0) return stats

  stats.samples = n
  stats.lum = sumL / n
  stats.r /= n
  stats.g /= n
  stats.b /= n
  stats.blueness /= n * 255
  stats.saturation = satN > 0 ? sumSat / satN : 0
  const variance = Math.max(0, sumL2 / n - stats.lum * stats.lum)
  stats.texture = Math.sqrt(variance) / 255
  return stats
}

interface Classification {
  kind: MaterialKind
  /** Sky is not a material — the caller drops these instead of texturing them. */
  sky: boolean
}

/**
 * The heuristics, and they are only heuristics: geometry (where the region sits
 * in the frame, how tall against how wide) plus average colour. No model, no
 * training data, no understanding of the scene. Anything that does not clearly
 * match returns 'unknown' — a wrong `kind` silently picks wrong processing
 * defaults downstream, which is worse for the user than being asked to choose.
 */
function classify(img: RGBAImage, quad: Quad): Classification {
  const w = img.width
  const h = img.height
  if (w < 1 || h < 1) return { kind: 'unknown', sky: false }

  const b = quadBounds(quad)
  const s = sampleRegion(img, quad, b)
  if (s.samples === 0) return { kind: 'unknown', sky: false }

  const spanX = (b.maxX - b.minX) / w
  const spanY = (b.maxY - b.minY) / h
  if (!(spanX > 0) || !(spanY > 0)) return { kind: 'unknown', sky: false }
  const aspect = (b.maxX - b.minX) / (b.maxY - b.minY)
  const centreY = b.cy / h
  const bottom = b.maxY / h
  const areaFraction = spanX * spanY

  // Sky: blue cast, not vividly saturated, sitting high in the frame, and flat.
  // Deliberately narrow — an overcast white sky has almost no blue cast and is
  // left as 'unknown' rather than risking a white wall being thrown away.
  if (s.blueness >= 0.08 && s.saturation <= 0.6 && centreY <= 0.35 && s.texture <= 0.07) {
    return { kind: 'unknown', sky: true }
  }

  // Ground: reaches the bottom edge and is broadly horizontal.
  if (bottom >= 0.85 && centreY >= 0.55 && aspect >= 1.6) return { kind: 'ground', sky: false }

  // Door: tall, narrow, and a serious share of the frame's height. The same
  // signature fits a metal gate; 'door' processing defaults are the closer
  // match of the two, and the user can switch the kind.
  if (aspect <= 0.65 && spanY >= 0.3 && spanX <= 0.4) return { kind: 'door', sky: false }

  // Rock: busy and mid-brown (red above green above blue, mid brightness).
  // The texture figure is a plain intensity spread, so a strong shadow gradient
  // over smooth render reads as "busy" too — hence the colour conditions doing
  // most of the work here.
  if (
    s.texture >= 0.085 &&
    s.r > s.g &&
    s.g > s.b &&
    s.lum >= 50 &&
    s.lum <= 190 &&
    s.saturation >= 0.12 &&
    s.saturation <= 0.6
  ) {
    return { kind: 'rock', sky: false }
  }

  // Wall: the catch-all for a big, flat, near-neutral surface — plaster, block,
  // concrete. Checked last so a textured or coloured surface gets first refusal.
  if (s.saturation <= 0.22 && areaFraction >= 0.12) return { kind: 'wall', sky: false }

  return { kind: 'unknown', sky: false }
}

/**
 * Guess what material a quad of the photo is. Heuristic, see `classify`.
 * Sky reports 'unknown' because sky is not a material kind; `segment` removes
 * those regions rather than handing them to the texture pipeline.
 */
export function classifyRegion(img: RGBAImage, quad: Quad): MaterialKind {
  return classify(img, quad).kind
}

// ------------------------------------------------------------------ segment

function buildRegions(entries: { quad: Quad; kind: MaterialKind }[]): PhotoRegion[] {
  const used: Partial<Record<MaterialKind, number>> = {}
  return entries.map((e, i) => {
    const n = (used[e.kind] ?? 0) + 1
    used[e.kind] = n
    // Numbered only from the second one on: "جدار" reads better than "جدار 1"
    // when there is a single wall.
    const label = n > 1 ? `${KIND_LABELS[e.kind]} ${n}` : KIND_LABELS[e.kind]
    return { id: `region-${i}`, label, quad: e.quad, kind: e.kind }
  })
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
 * Split a photo into candidate material regions, entirely locally: downscale,
 * quantise to a six-colour palette, label connected blobs of each palette
 * entry, drop the small ones, and return each survivor's bounding box scaled
 * back to full-resolution source coordinates.
 *
 * Deterministic: the same pixels always produce the same regions, in the same
 * order, with the same ids.
 */
export function segment(img: RGBAImage, opts: Partial<SegmentOptions> = {}): PhotoRegion[] {
  const maxRegions = Math.max(1, Math.floor(opts.maxRegions ?? DEFAULT_SEGMENT.maxRegions))
  const minAreaFraction = clamp(opts.minAreaFraction ?? DEFAULT_SEGMENT.minAreaFraction, 0.0005, 0.5)
  if (img.width < 1 || img.height < 1) return []

  const k = Math.min(1, WORK_MAX_DIM / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * k))
  const h = Math.max(1, Math.round(img.height * k))
  // Below this the work plane has fewer pixels than the palette has meaningful
  // clusters; one region covering the frame is the honest answer.
  if (w < 8 || h < 8) {
    const quad = wholeFrame(img)
    const c = classify(img, quad)
    return c.sky ? [] : buildRegions([{ quad, kind: c.kind }])
  }

  const px = downscaleRGB(img, w, h)
  const quantised = kmeans(px, PALETTE_K)
  const labels = despeckle(quantised.labels, w, h, quantised.k)
  const comps = connectedComponents(labels, w, h, Math.max(1, minAreaFraction * w * h))

  const sx = img.width / w
  const sy = img.height / h
  const kept: { quad: Quad; kind: MaterialKind }[] = []
  for (const c of comps) {
    if (kept.length >= maxRegions) break
    const quad = boxToQuad(c, sx, sy, img.width, img.height)
    // Classify against the full-resolution pixels, not the 256px plane: texture
    // and saturation both wash out under a 20x box downscale.
    const cls = classify(img, quad)
    if (cls.sky) continue
    kept.push({ quad, kind: cls.kind })
  }

  // Nothing survived — a close-up of gravel or grass fragments into hundreds of
  // sub-threshold blobs and every one of them is dropped. Returning the whole
  // frame is both truthful ("this photo is one surface") and the region the
  // user would have drawn by hand anyway.
  if (kept.length === 0) {
    const quad = wholeFrame(img)
    const cls = classify(img, quad)
    if (!cls.sky) kept.push({ quad, kind: cls.kind })
  }
  return buildRegions(kept)
}

// ------------------------------------------------------------------- remote

interface RemoteRegion {
  label?: unknown
  quad?: unknown
  kind?: unknown
}

function parseQuad(value: unknown, w: number, h: number): Quad | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  const pts = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return null
    const p = raw as { x?: unknown; y?: unknown }
    if (typeof p.x !== 'number' || typeof p.y !== 'number') return null
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
    // Clamped: a service returning coordinates slightly outside the frame is
    // common and harmless, a NaN downstream in the homography solve is not.
    pts.push({ x: clamp(p.x, 0, w), y: clamp(p.y, 0, h) })
  }
  return pts as Quad
}

/**
 * Segmentation by a real model. POSTs `{image: <png data url>}` to `endpoint`
 * and expects `{regions: [{label, quad, kind}]}`, where `quad` is four
 * `{x, y}` corners in TL,TR,BR,BL order in *source pixel* coordinates and
 * `kind` is one of MaterialKind.
 *
 * This — a SAM/Segment-Anything service behind the seam — is what produces
 * masks good enough to use without editing. `segment` is the offline fallback.
 *
 * Never throws and never rejects: any failure (offline, non-200, malformed
 * body, no usable region, a browser-only encode running in Node) returns null
 * so the caller can quietly run the local path instead.
 */
export async function segmentRemote(img: RGBAImage, endpoint: string): Promise<PhotoRegion[] | null> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: toDataURL(img) }),
    })
    if (!res.ok) {
      console.warn('[segment] remote segmentation returned', res.status, '- falling back to local')
      return null
    }

    const json = (await res.json()) as { regions?: unknown }
    if (!Array.isArray(json.regions)) return null

    const out: PhotoRegion[] = []
    for (const raw of json.regions as RemoteRegion[]) {
      if (typeof raw !== 'object' || raw === null) continue
      const quad = parseQuad(raw.quad, img.width, img.height)
      if (!quad) continue
      const kind =
        typeof raw.kind === 'string' && (MATERIAL_KINDS as string[]).includes(raw.kind)
          ? (raw.kind as MaterialKind)
          : 'unknown'
      const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label : KIND_LABELS[kind]
      out.push({ id: `remote-${out.length}`, label, quad, kind })
    }

    // An empty result is treated as a failure rather than as "this photo has no
    // surfaces": the local pass will at least give the user something to drag.
    return out.length > 0 ? out : null
  } catch (err) {
    console.warn('[segment] remote segmentation failed, falling back to local', err)
    return null
  }
}
