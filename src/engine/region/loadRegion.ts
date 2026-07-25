import {
  decodeElevation,
  roadLength,
  type RegionData,
  type RegionElevation,
  type RegionPoint,
  type RegionRoad,
} from './types'

/**
 * Load, validate and describe a baked region file.
 *
 * The whole neighbourhood ships inside public/regions/, so this never touches
 * the network in the packaged build — it is a file read that happens to speak
 * fetch(). Everything here is plain data in, plain data out: no Babylon, no
 * canvas, so the validator and the statistics can be exercised from Node.
 */

/** Problems that start with this are advisory; anything else blocks loading. */
const WARN = 'تحذير: '

/** Stop listing individual faults per section; a wall of text helps nobody. */
const MAX_PER_SECTION = 5

/**
 * Baseline over which road grade is measured, metres.
 *
 * Grade is a property of a stretch of road, not of a point. OSM nodes can sit
 * 1–2 m apart while the elevation grid samples every 4 m, so a per-node rise
 * over run mostly measures interpolation ripple and reports cliffs that are not
 * there. Ten metres is roughly the length of the truck plus its trailer tongue
 * — the distance over which a gradient actually decides whether it climbs.
 */
const GRADE_BASELINE_M = 10

/** Below this the sample is too short to mean anything at 4 m data resolution. */
const MIN_RUN_M = 5

export interface RegionStats {
  name: string
  sizeM: number
  roadCount: number
  roadKm: number
  buildingCount: number
  reliefM: number
  minElevationM: number
  maxElevationM: number
  /** Steepest along-road gradient anywhere in the region, as a percentage. */
  steepestRoadGrade: number
  byClass: Record<string, number>
}

// ------------------------------------------------------------------- loading

/**
 * Fetch and parse a baked region, refusing anything that would fail obscurely
 * later on.
 *
 * `url` is used as given. Under file:// in the packaged desktop build a
 * same-directory relative URL resolves and reads fine, so there is no special
 * casing here — only the error handling has to cope with the fact that a file
 * read fails as a thrown TypeError rather than as a 404.
 */
export async function loadRegion(url: string): Promise<RegionData> {
  let raw: string
  try {
    raw = await fetchText(url)
  } catch (err) {
    throw new Error(`تعذر الوصول إلى ملف المنطقة ${url} — ${errorText(err)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // The usual cause is a dev server answering a missing file with the SPA's
    // index.html at status 200, so show what actually arrived instead of
    // "Unexpected token < in JSON".
    const head = raw.slice(0, 80).replace(/\s+/g, ' ').trim()
    throw new Error(`ملف المنطقة ${url} ليس JSON صالحاً. بداية المحتوى: «${head}»`)
  }

  const problems = validateRegion(parsed)
  const fatal = problems.filter((p) => !p.startsWith(WARN))
  if (fatal.length > 0) {
    throw new Error(`ملف المنطقة ${url} غير صالح:\n- ${fatal.join('\n- ')}`)
  }
  for (const w of problems) console.warn('[region]', w)

  return parsed as RegionData
}

// ---------------------------------------------------------------- validation

/**
 * Check a parsed region against the contract.
 *
 * Returns human-readable Arabic problems, empty when the data is sound. Lines
 * prefixed with «تحذير:» are survivable oddities — a road of zero length, a
 * header figure that disagrees with the grid — and loadRegion lets those pass.
 *
 * Note what is deliberately NOT checked: road and building coordinates are
 * allowed outside the ±sizeM/2 square. The baker queries Overpass with a bbox
 * in degrees and does not clip ways, so a street that leaves the region keeps
 * its far nodes. Consumers clip; the file is not wrong.
 */
export function validateRegion(data: unknown): string[] {
  const out: string[] = []
  if (!isRecord(data)) {
    return ['البيانات ليست كائن JSON صالحاً للمنطقة']
  }

  if (!isNonEmptyString(data.name)) out.push('اسم المنطقة (name) مفقود أو فارغ')
  // ODbL requires the credit to travel with the data, so a region without it is
  // not shippable rather than merely untidy.
  if (!isNonEmptyString(data.attribution)) out.push('نص الإسناد (attribution) مفقود — رخصة OSM تُلزم بعرضه')

  const center = data.center
  if (!isRecord(center) || !isFinite2(center.lat, center.lon)) {
    out.push('مركز المنطقة (center) مفقود أو يحتوي على إحداثيات غير رقمية')
  } else if (Math.abs(center.lat as number) > 90 || Math.abs(center.lon as number) > 180) {
    out.push('مركز المنطقة خارج نطاق خطوط الطول والعرض')
  }

  const sizeM = data.sizeM
  if (!isFiniteNumber(sizeM) || sizeM <= 0) {
    out.push('طول ضلع المنطقة (sizeM) يجب أن يكون رقماً موجباً')
  }
  if (isFiniteNumber(data.radiusM) && isFiniteNumber(sizeM) && Math.abs(data.radiusM * 2 - sizeM) > 1) {
    out.push(`${WARN}نصف القطر (${data.radiusM} م) لا يطابق نصف طول الضلع (${sizeM} م)`)
  }

  out.push(...validateElevation(data.elevation))
  out.push(...validateRoads(data.roads, data.roadOrder))
  out.push(...validateBuildings(data.buildings))
  out.push(...validateAreas(data.areas))

  return out
}

function validateElevation(e: unknown): string[] {
  if (!isRecord(e)) return ['شبكة الارتفاعات (elevation) مفقودة']
  const out: string[] = []

  const res = e.res
  if (!isFiniteNumber(res) || !Number.isInteger(res) || res < 2) {
    out.push('دقة شبكة الارتفاعات (elevation.res) يجب أن تكون عدداً صحيحاً ≥ 2')
  }
  if (!isFinite2(e.minM, e.maxM)) {
    out.push('حدود الارتفاع (minM/maxM) غير رقمية')
  } else if ((e.maxM as number) < (e.minM as number)) {
    out.push('أعلى ارتفاع أقل من أدنى ارتفاع')
  }
  if (e.encoding !== 'u16-decimetres-base64') {
    out.push(`ترميز الارتفاعات غير مدعوم: ${String(e.encoding)}`)
  }
  if (!isNonEmptyString(e.data)) {
    out.push('بيانات الارتفاع (elevation.data) مفقودة أو فارغة')
    return out
  }
  if (out.length > 0) return out

  const side = res as number
  let grid: Float32Array
  try {
    grid = decodeElevation(e as unknown as RegionElevation)
  } catch (err) {
    out.push(`تعذر فك ترميز شبكة الارتفاعات — ${errorText(err)}`)
    return out
  }
  if (grid.length !== side * side) {
    out.push(`حجم شبكة الارتفاعات ${grid.length} عيّنة لا يطابق ${side}×${side} = ${side * side}`)
    return out
  }

  // The header figures drive the UI, so catch a stale bake where they no longer
  // describe the grid they ship with.
  let max = -Infinity
  for (let i = 0; i < grid.length; i++) if (grid[i] > max) max = grid[i]
  if (Math.abs(max - (e.maxM as number)) > 0.5) {
    out.push(`${WARN}أعلى ارتفاع مُعلن ${(e.maxM as number).toFixed(1)} م بينما الشبكة تبلغ ${max.toFixed(1)} م`)
  }
  return out
}

function validateRoads(roads: unknown, roadOrder: unknown): string[] {
  if (!Array.isArray(roads)) return ['قائمة الطرق (roads) مفقودة أو ليست مصفوفة']
  const out: string[] = []
  const known = new Set(Array.isArray(roadOrder) ? roadOrder.map(String) : [])
  const { note, flush } = sectionReporter(out, 'الطرق')

  for (let i = 0; i < roads.length; i++) {
    const r: unknown = roads[i]
    if (!isRecord(r)) {
      note(`الطريق رقم ${i} ليس كائناً`)
      continue
    }
    const label = isNonEmptyString(r.name) ? `«${r.name}»` : `رقم ${i}`
    if (!isNonEmptyString(r.cls)) note(`الطريق ${label} بلا تصنيف (cls)`)
    else if (known.size > 0 && !known.has(r.cls)) note(`${WARN}الطريق ${label} من تصنيف غير مُدرج في roadOrder: ${r.cls}`)

    if (!isFiniteNumber(r.halfWidth) || r.halfWidth <= 0) note(`الطريق ${label} بعرض غير صالح (halfWidth)`)

    const pts = r.pts
    if (!Array.isArray(pts) || pts.length < 2) {
      note(`الطريق ${label} يحتاج نقطتين على الأقل، وجدنا ${Array.isArray(pts) ? pts.length : 0}`)
      continue
    }
    const bad = firstBadPoint(pts)
    if (bad >= 0) {
      note(`الطريق ${label} يحتوي على إحداثيات غير رقمية عند النقطة ${bad}`)
      continue
    }
    if (roadLength(r as unknown as RegionRoad) <= 0) {
      note(`${WARN}الطريق ${label} طوله صفر — كل نقاطه متطابقة`)
    }
  }

  flush()
  return out
}

function validateBuildings(buildings: unknown): string[] {
  if (!Array.isArray(buildings)) return ['قائمة المباني (buildings) مفقودة أو ليست مصفوفة']
  const out: string[] = []
  const { note, flush } = sectionReporter(out, 'المباني')

  for (let i = 0; i < buildings.length; i++) {
    const b: unknown = buildings[i]
    if (!isRecord(b)) {
      note(`المبنى رقم ${i} ليس كائناً`)
      continue
    }
    if (!isNonEmptyString(b.kind)) note(`المبنى رقم ${i} بلا نوع (kind)`)
    if (!isFiniteNumber(b.height) || b.height <= 0) note(`المبنى رقم ${i} بارتفاع غير صالح`)
    if (!isFiniteNumber(b.area) || b.area < 0) note(`${WARN}المبنى رقم ${i} بمساحة غير صالحة`)

    const ring = b.ring
    if (!Array.isArray(ring) || ring.length < 3) {
      note(`المبنى رقم ${i} يحتاج ثلاث نقاط على الأقل، وجدنا ${Array.isArray(ring) ? ring.length : 0}`)
      continue
    }
    const bad = firstBadPoint(ring)
    if (bad >= 0) note(`المبنى رقم ${i} يحتوي على إحداثيات غير رقمية عند النقطة ${bad}`)
    // The contract says the first point is not repeated; a repeated one would
    // give the mesher a zero-length edge.
    else if (samePoint(ring[0] as RegionPoint, ring[ring.length - 1] as RegionPoint)) {
      note(`${WARN}المبنى رقم ${i} يكرر نقطته الأولى في نهاية الحلقة`)
    }
  }

  flush()
  return out
}

function validateAreas(areas: unknown): string[] {
  if (!Array.isArray(areas)) return ['قائمة المساحات (areas) مفقودة أو ليست مصفوفة']
  const out: string[] = []
  const { note, flush } = sectionReporter(out, 'المساحات')

  for (let i = 0; i < areas.length; i++) {
    const a: unknown = areas[i]
    if (!isRecord(a)) {
      note(`المساحة رقم ${i} ليست كائناً`)
      continue
    }
    if (!isNonEmptyString(a.kind)) note(`المساحة رقم ${i} بلا نوع (kind)`)
    const ring = a.ring
    if (!Array.isArray(ring) || ring.length < 3) {
      note(`المساحة رقم ${i} تحتاج ثلاث نقاط على الأقل، وجدنا ${Array.isArray(ring) ? ring.length : 0}`)
      continue
    }
    const bad = firstBadPoint(ring)
    if (bad >= 0) note(`المساحة رقم ${i} تحتوي على إحداثيات غير رقمية عند النقطة ${bad}`)
  }

  flush()
  return out
}

/**
 * Collector that keeps the first few faults of a section verbatim and folds the
 * rest into one line. Severity of the folded line follows the worst it swallowed,
 * so capping the output can never turn a fatal problem into a warning.
 */
function sectionReporter(out: string[], section: string) {
  let shown = 0
  let hidden = 0
  let hiddenFatal = false

  const note = (msg: string) => {
    if (shown < MAX_PER_SECTION) {
      out.push(msg)
      shown++
      return
    }
    hidden++
    if (!msg.startsWith(WARN)) hiddenFatal = true
  }
  const flush = () => {
    if (hidden === 0) return
    const counted = arabicCount(hidden, ['', 'مشكلة واحدة', 'مشكلتان', 'مشاكل', 'مشكلة'])
    const line = `و${counted} أخرى في ${section} لم تُعرض`
    out.push(hiddenFatal ? line : WARN + line)
  }
  return { note, flush }
}

// ---------------------------------------------------------------- statistics

/**
 * Real numbers for the dashboard.
 *
 * `heightAt` is optional and matters more than it looks. Pass none and the
 * grades are measured on the bare baked terrain — the hill as SRTM saw it. Pass
 * a RegionHeightField that has already run flattenRoads() and you get the grades
 * of the streets the truck will actually drive, which are gentler and are the
 * honest answer to "will it climb this?".
 */
export function describeRegion(r: RegionData, heightAt?: (x: number, z: number) => number): RegionStats {
  const grid = decodeElevation(r.elevation)
  let minElevationM = Infinity
  let maxElevationM = -Infinity
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i]
    if (v < minElevationM) minElevationM = v
    if (v > maxElevationM) maxElevationM = v
  }

  const sample = heightAt ?? gridSampler(r, grid)

  let roadKm = 0
  const byClass: Record<string, number> = {}
  for (const road of r.roads) {
    roadKm += roadLength(road) / 1000
    byClass[road.cls] = (byClass[road.cls] ?? 0) + 1
  }

  return {
    name: r.name,
    sizeM: r.sizeM,
    roadCount: r.roads.length,
    roadKm,
    buildingCount: r.buildings.length,
    reliefM: maxElevationM - minElevationM,
    minElevationM,
    maxElevationM,
    steepestRoadGrade: steepestGrade(r, sample) * 100,
    byClass: orderByClassList(byClass, r.roadOrder),
  }
}

/**
 * Maximum rise over run along any road centreline, as a fraction.
 *
 * Each centreline is resampled to an even ~10 m step and the gradient is taken
 * between consecutive samples. Pairs with an endpoint outside the region are
 * skipped: the baker does not clip ways, and every sampler clamps at the edge,
 * so an outside pair would report the flat of the clamp rather than real ground.
 */
function steepestGrade(r: RegionData, sample: (x: number, z: number) => number): number {
  const half = r.sizeM * 0.5
  const inside = (p: RegionPoint) => Math.abs(p.x) <= half && Math.abs(p.z) <= half

  let steepest = 0
  for (const road of r.roads) {
    const path = resample(road.pts, GRADE_BASELINE_M)
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]
      const b = path[i]
      if (!inside(a) || !inside(b)) continue
      const run = Math.hypot(b.x - a.x, b.z - a.z)
      if (run < MIN_RUN_M) continue
      const grade = Math.abs(sample(b.x, b.z) - sample(a.x, a.z)) / run
      if (grade > steepest) steepest = grade
    }
  }
  return steepest
}

/** Evenly spaced points along a polyline, roughly `step` metres apart. */
function resample(pts: RegionPoint[], step: number): RegionPoint[] {
  if (pts.length < 2) return []
  const cum = new Float64Array(pts.length)
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
  }
  const total = cum[pts.length - 1]
  if (!(total > 0)) return []

  const n = Math.max(2, Math.round(total / step) + 1)
  const out: RegionPoint[] = new Array(n)
  let seg = 0
  for (let i = 0; i < n; i++) {
    const d = (total * i) / (n - 1)
    while (seg < pts.length - 2 && cum[seg + 1] < d) seg++
    const segLen = cum[seg + 1] - cum[seg]
    const t = segLen > 0 ? (d - cum[seg]) / segLen : 0
    out[i] = {
      x: pts[seg].x + (pts[seg + 1].x - pts[seg].x) * t,
      z: pts[seg].z + (pts[seg + 1].z - pts[seg].z) * t,
    }
  }
  return out
}

/**
 * Bilinear sampler over the raw grid, used when the caller has no height field.
 *
 * Bilinear rather than the bicubic RegionHeightField uses: this only ever feeds
 * statistics, and over a 10 m baseline the two agree to well under a percent of
 * grade while this stays a dozen lines with no state.
 */
function gridSampler(r: RegionData, grid: Float32Array): (x: number, z: number) => number {
  const res = r.elevation.res
  const spacing = r.sizeM / (res - 1)
  const half = r.sizeM * 0.5
  const at = (col: number, row: number) => {
    const c = col < 0 ? 0 : col >= res ? res - 1 : col
    const rw = row < 0 ? 0 : row >= res ? res - 1 : row
    return grid[rw * res + c]
  }
  return (x, z) => {
    // Row 0 is the south edge and column 0 the west edge, matching +X east /
    // +Z north, so both axes map straight through without a flip.
    const gx = (x + half) / spacing
    const gz = (z + half) / spacing
    const cx = Math.floor(gx)
    const cz = Math.floor(gz)
    const tx = gx - cx
    const tz = gz - cz
    const s = at(cx, cz) + (at(cx + 1, cz) - at(cx, cz)) * tx
    const n = at(cx, cz + 1) + (at(cx + 1, cz + 1) - at(cx, cz + 1)) * tx
    return s + (n - s) * tz
  }
}

/** Rebuild the count map in roadOrder, coarsest first, extras appended. */
function orderByClassList(counts: Record<string, number>, order: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const cls of order) if (counts[cls] !== undefined) out[cls] = counts[cls]
  for (const cls of Object.keys(counts)) if (out[cls] === undefined) out[cls] = counts[cls]
  return out
}

// ------------------------------------------------------------------- Arabic

const REGION_NAME_AR: Record<string, string> = {
  khalidiya: 'الخالدية',
}

const ROAD_CLASS_AR: Record<string, string> = {
  motorway: 'سريع',
  trunk: 'شرياني',
  primary: 'رئيسي',
  secondary: 'ثانوي',
  tertiary: 'فرعي',
  unclassified: 'غير مصنف',
  residential: 'سكني',
  living_street: 'شارع هادئ',
  service: 'خدمي',
  track: 'ترابي',
  pedestrian: 'مشاة',
  footway: 'ممر مشاة',
  path: 'مسار',
  steps: 'درج',
}

/** Compact multi-line summary for the dashboard panel. */
export function regionSummaryArabic(s: RegionStats): string {
  const areaKm2 = (s.sizeM * s.sizeM) / 1e6
  const classes = Object.entries(s.byClass)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cls, n]) => `${ROAD_CLASS_AR[cls] ?? cls} ${n}`)
    .join(' · ')

  const lines = [
    `المنطقة: ${REGION_NAME_AR[s.name] ?? s.name}`,
    `المساحة: ${fmt(s.sizeM)} × ${fmt(s.sizeM)} م (${areaKm2.toFixed(1)} كم²)`,
    `الطرق: ${arabicCount(s.roadCount, ['لا طرق', 'طريق واحد', 'طريقان', 'طرق', 'طريقاً'])} بطول ${s.roadKm.toFixed(1)} كم`,
  ]
  if (classes) lines.push(`التصنيف: ${classes}`)
  lines.push(
    `المباني: ${arabicCount(s.buildingCount, ['لا مبانٍ', 'مبنى واحد', 'مبنيان', 'مبانٍ', 'مبنى'])}`,
  )
  // OSM coverage here is one building for the whole square, so say plainly that
  // what the player sees is generated rather than surveyed.
  if (s.buildingCount < 5) lines.push('بيانات المباني شبه غائبة — يجري توليدها إجرائياً على قطع الأراضي')
  lines.push(
    `الارتفاع: من ${Math.round(s.minElevationM)} إلى ${Math.round(s.maxElevationM)} م فوق سطح البحر (فارق ${Math.round(s.reliefM)} م)`,
    `أشد انحدار على الطرق: ${s.steepestRoadGrade.toFixed(1)}٪`,
  )
  return lines.join('\n')
}

/**
 * Arabic counted noun. Forms are [zero, one, two, few (3–10), many (11+)];
 * "few" takes the plural and "many" the accusative singular, so «٣ مبانٍ» and
 * «١٥٥ طريقاً» both read correctly.
 */
function arabicCount(n: number, forms: [string, string, string, string, string]): string {
  if (n === 0) return forms[0]
  if (n === 1) return forms[1]
  if (n === 2) return forms[2]
  const rem = n % 100
  return rem >= 3 && rem <= 10 ? `${fmt(n)} ${forms[3]}` : `${fmt(n)} ${forms[4]}`
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

// -------------------------------------------------------------------- listing

/**
 * Regions the build might ship. HTTP gives no directory listing and file://
 * gives even less, so discovery is a probe of a known manifest — add a name
 * here when a new region is baked into public/regions/.
 */
const REGION_CANDIDATES = ['khalidiya']

/** Names actually present under public/regions/. */
export async function listRegions(): Promise<string[]> {
  const hits = await Promise.all(
    REGION_CANDIDATES.map(async (name) => ((await regionExists(regionUrl(name))) ? name : null)),
  )
  return hits.filter((n): n is string => n !== null)
}

/** URL of a baked region, relative so it survives the file:// desktop build. */
function regionUrl(name: string): string {
  return `regions/${name}.json`
}

/**
 * True when the file is there. A missing region is the expected answer, not an
 * error: over HTTP it arrives as 404 and over file:// as a thrown TypeError, and
 * neither is logged — a probe that shouted every time would fill the console
 * with noise about regions nobody ever baked.
 */
async function regionExists(url: string): Promise<boolean> {
  if (isFileOrigin()) {
    try {
      await requestXhr(url, 'HEAD')
      return true
    } catch {
      return false
    }
  }
  try {
    const res = await fetch(url, { method: 'HEAD' })
    if (!res.ok) return false
    // Vite answers an unknown path with the SPA shell at status 200, so an HTML
    // content type means the region is absent, not present.
    const type = res.headers.get('content-type') ?? ''
    return !type.toLowerCase().startsWith('text/html')
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ transport

/**
 * Read a text file over whichever transport the app is actually running on.
 *
 * The packaged desktop build serves the page from file://, and Chromium's
 * fetch() refuses that scheme outright — it throws before any read is
 * attempted. XHR is the only path that works there, and it is the same
 * fallback assetOverrides uses for exactly the same reason. Getting this wrong
 * is invisible in the browser and breaks only the shipped .exe, which is the
 * build the user actually plays.
 */
async function fetchText(url: string): Promise<string> {
  if (isFileOrigin()) return requestXhr(url, 'GET')

  const res = await fetch(url)
  // Chromium reports status 0 for a successful non-HTTP read; only a real HTTP
  // status counts as a failure.
  if (!res.ok && res.status !== 0) {
    throw new Error(`${res.status} ${res.statusText}`.trim())
  }
  return res.text()
}

function isFileOrigin(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'file:'
}

/** Rejects on a missing file; resolves with the body (empty for HEAD). */
function requestXhr(url: string, method: 'GET' | 'HEAD'): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(method, url, true)
    // A 737 KB region off local disk; anything slower than this is a wrong path.
    xhr.timeout = 30000
    xhr.onload = () => {
      // file:// reads report status 0 on success and never reach onload when
      // the path is missing — that fires onerror instead.
      if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
        resolve(xhr.responseText ?? '')
      } else {
        reject(new Error(`${xhr.status} ${xhr.statusText}`.trim()))
      }
    }
    xhr.onerror = () => reject(new Error('الملف غير موجود'))
    xhr.onabort = () => reject(new Error('أُلغي الطلب'))
    xhr.ontimeout = () => reject(new Error('انتهت مهلة القراءة'))
    xhr.send()
  })
}

// -------------------------------------------------------------------- helpers

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isFinite2(a: unknown, b: unknown): boolean {
  return isFiniteNumber(a) && isFiniteNumber(b)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** Index of the first point that is not a pair of finite numbers, else -1. */
function firstBadPoint(pts: unknown[]): number {
  for (let i = 0; i < pts.length; i++) {
    const p: unknown = pts[i]
    if (!isRecord(p) || !isFinite2(p.x, p.z)) return i
  }
  return -1
}

function samePoint(a: RegionPoint, b: RegionPoint): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6
}
