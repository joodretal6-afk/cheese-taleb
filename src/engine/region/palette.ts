import type { RoadClass } from './types'

/**
 * The user-editable skin over a baked region.
 *
 * The baker decides where the asphalt is; this decides what asphalt looks like.
 * Nine surface keys cover the whole neighbourhood, deliberately far fewer than
 * the 14 OSM road classes: a person tuning their town wants "the main roads"
 * and "the side streets", not a separate swatch for `living_street`. The
 * collapse happens once, in roadClassToKey, so the mesh groups roadMesh emits
 * map straight onto materials.
 *
 * Plain data and pure functions only — no Babylon types, no scene — so a
 * palette can be built, validated and diffed in bare Node.
 */

export type SurfaceKey =
  | 'road:major' | 'road:residential' | 'road:service' | 'road:path'
  | 'building:wall' | 'building:roof'
  | 'ground:bare' | 'ground:rock' | 'ground:vegetation'

export interface SurfaceStyle {
  /** Arabic, shown next to the swatch. */
  label: string
  /** '#rrggbb'. */
  color: string
  roughness: number
  metallic: number
  /** Albedo map as a data:, blob:, file: or relative URL. Null keeps the flat colour. */
  textureUrl: string | null
  /** Metres of world covered by one texture repeat. */
  tileMetres: number
}

export type Palette = Record<SurfaceKey, SurfaceStyle>

/**
 * Canonical key order. Used for serialisation, comparison and rebuilding, so
 * two equal palettes always produce byte-identical JSON and an unknown key in
 * a pasted palette simply never gets read.
 */
const SURFACE_KEYS: SurfaceKey[] = [
  'road:major', 'road:residential', 'road:service', 'road:path',
  'building:wall', 'building:roof',
  'ground:bare', 'ground:rock', 'ground:vegetation',
]

// ---------------------------------------------------------------------------
// Defaults — Al-Khalidiya, semi-arid northern Jordan
// ---------------------------------------------------------------------------

/**
 * Roughness is the only value here worth arguing about, so the reasoning is
 * inline per entry. The short version: bitumen has a binder and holds a faint
 * sheen even when sun-bleached, loose soil has none at all, and broken
 * limestone sits between the two because a fresh cleavage face is a flatter
 * micro-surface than dust is.
 *
 * Metallic is 0 everywhere: every surface in a town like this is a dielectric.
 * The field exists so a user can push a roof to corrugated zinc, which is
 * common enough on sheds here to be worth allowing.
 */
const DEFAULTS: Palette = {
  'road:major': {
    label: 'طرق رئيسية',
    // Weathered grey bitumen, lifted and desaturated by a decade of sun.
    color: '#55534f',
    // Polished by traffic and still bound by bitumen — the shiniest ground
    // surface in the region, and the only one that reads wet in rain.
    roughness: 0.82,
    metallic: 0,
    textureUrl: null,
    tileMetres: 6,
  },
  'road:residential': {
    label: 'شوارع سكنية',
    // Lighter: thinner wearing course, less traffic polish, permanent dust film.
    color: '#6b675e',
    // That dust film is what kills the sheen the main roads keep.
    roughness: 0.88,
    metallic: 0,
    textureUrl: null,
    tileMetres: 5,
  },
  'road:service': {
    label: 'طرق خدمية ترابية',
    // Compacted dirt track, the colour of the soil it was cut from.
    color: '#8a7a63',
    // Loose fines scatter in every direction; effectively no specular lobe.
    roughness: 0.96,
    metallic: 0,
    textureUrl: null,
    tileMetres: 4,
  },
  'road:path': {
    label: 'ممرات ومشايات',
    // Foot-worn dust, paler than a vehicle track because it is never turned over.
    color: '#9c8c72',
    roughness: 0.97,
    metallic: 0,
    textureUrl: null,
    tileMetres: 3,
  },
  'building:wall': {
    label: 'جدران المباني',
    // Cream local limestone cladding, the default facade across the region.
    color: '#d8c7a4',
    // Dressed stone starts fairly smooth, but wind-blown sand frosts it within
    // a few seasons, so it sits well above a polished-stone value.
    roughness: 0.85,
    metallic: 0,
    textureUrl: null,
    // Roughly a two-course band of block, so the tiling reads as masonry scale.
    tileMetres: 2.4,
  },
  'building:roof': {
    label: 'أسطح المباني',
    // Bare light grey concrete slab — flat roofs, tanks and stairwells.
    color: '#b0aca3',
    // Screeded concrete: open pores, no binder film left on top.
    roughness: 0.9,
    metallic: 0,
    textureUrl: null,
    tileMetres: 3,
  },
  'ground:bare': {
    label: 'تربة جرداء',
    // Dry tan soil between the plots — the dominant colour of the whole scene.
    color: '#c2a97e',
    roughness: 0.95,
    metallic: 0,
    textureUrl: null,
    // Large tile: this covers most of 4 km², and a small repeat visibly grids.
    tileMetres: 8,
  },
  'ground:rock': {
    label: 'صخور مكشوفة',
    // Pale exposed limestone, greyer and cooler than the soil around it.
    color: '#a89f90',
    // Lower than soil on purpose: broken rock exposes flat cleavage faces that
    // catch a hard highlight at grazing sun, which is exactly what makes an
    // outcrop read as rock rather than as a differently-coloured patch of dirt.
    roughness: 0.78,
    metallic: 0,
    textureUrl: null,
    tileMetres: 6,
  },
  'ground:vegetation': {
    label: 'أعشاب وشجيرات',
    // Sparse olive-grey scrub; never the saturated green of a temperate lawn.
    color: '#7d8360',
    // Waxy leaf cuticle, evolved to hold water in, gives a genuine broad sheen.
    roughness: 0.7,
    metallic: 0,
    textureUrl: null,
    tileMetres: 5,
  },
}

/**
 * Frozen, including every style object.
 *
 * The default is shared by the whole app and is what "reset" restores. A
 * shallow `{ ...DEFAULT_PALETTE }` followed by an in-place edit of one entry
 * would otherwise destroy it for every later reader, silently. Frozen, that
 * mistake throws at the line that caused it. Copy before editing, or build the
 * new entry with a spread.
 */
export const DEFAULT_PALETTE: Palette = deepFreeze(DEFAULTS)

function deepFreeze(p: Palette): Palette {
  for (const key of SURFACE_KEYS) Object.freeze(p[key])
  return Object.freeze(p)
}

// ---------------------------------------------------------------------------
// Road classes
// ---------------------------------------------------------------------------

/**
 * Exhaustive by type: adding a RoadClass in types.ts breaks this table at
 * compile time instead of silently falling through to a default at runtime.
 *
 * `unclassified` goes with the residential streets rather than the major ones —
 * in Jordan it tags an ordinary paved local road, and Khalidiya's 10 of them
 * are indistinguishable from its 130 residential streets on the ground.
 * `track` joins the service roads because both are graded dirt here.
 */
const ROAD_CLASS_KEYS: Record<RoadClass, SurfaceKey> = {
  motorway: 'road:major',
  trunk: 'road:major',
  primary: 'road:major',
  secondary: 'road:major',
  tertiary: 'road:major',
  unclassified: 'road:residential',
  residential: 'road:residential',
  living_street: 'road:residential',
  service: 'road:service',
  track: 'road:service',
  pedestrian: 'road:path',
  footway: 'road:path',
  path: 'road:path',
  steps: 'road:path',
}

export function roadClassToKey(cls: RoadClass): SurfaceKey {
  // The lookup can still miss if a hand-edited region JSON carries a class the
  // contract does not name; residential is the safe majority answer.
  return ROAD_CLASS_KEYS[cls] ?? 'road:residential'
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Numbers arrive from range sliders and from text inputs that round-trip
 * through JSON, so 0.82 and 0.8200000000000001 are the same value as far as a
 * "has the user changed anything?" check is concerned. Exact equality here
 * would light up the unsaved-changes indicator on a palette nobody touched.
 */
const NUM_EPS = 1e-6

function nearly(a: number, b: number): boolean {
  return Math.abs(a - b) <= NUM_EPS
}

export function palettesEqual(a: Palette, b: Palette): boolean {
  for (const key of SURFACE_KEYS) {
    const x = a[key]
    const y = b[key]
    if (!x || !y) return x === y // tolerate a hand-built palette missing a key
    if (x.label !== y.label) return false
    // '#D8C7A4' and '#d8c7a4' are one colour; a colour input may return either.
    if (x.color.toLowerCase() !== y.color.toLowerCase()) return false
    if (x.textureUrl !== y.textureUrl) return false
    if (!nearly(x.roughness, y.roughness)) return false
    if (!nearly(x.metallic, y.metallic)) return false
    if (!nearly(x.tileMetres, y.tileMetres)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Fixed key order and fixed field order inside each entry, so two palettes that
 * compare equal also serialise to identical text. That is what lets a caller
 * store the string and compare strings, and what keeps a saved palette from
 * churning in version control every time it is rewritten.
 */
export function serialisePalette(p: Palette): string {
  const out: Record<string, SurfaceStyle> = {}
  for (const key of SURFACE_KEYS) {
    const s = p[key] ?? DEFAULT_PALETTE[key]
    out[key] = {
      label: s.label,
      color: s.color,
      roughness: s.roughness,
      metallic: s.metallic,
      textureUrl: s.textureUrl,
      tileMetres: s.tileMetres,
    }
  }
  return JSON.stringify(out, null, 2)
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A roughness of 0 is a mirror. No surface in a dusty town is one. */
const MIN_ROUGHNESS = 0.04
/** Below a few centimetres the repeat aliases into moiré at any real distance. */
const MIN_TILE_M = 0.05
/** Above the region's own 2 km side a tile is just a flat colour with extra cost. */
const MAX_TILE_M = 2000
/** Long enough for a paragraph pasted by mistake to be truncated, not rendered. */
const MAX_LABEL_CHARS = 64
/** ~8 MB, comfortably above a 2048² base64 JPEG and below a memory problem. */
const MAX_TEXTURE_URL_CHARS = 8 * 1024 * 1024

const HEX6 = /^#[0-9a-f]{6}$/i
const HEX3 = /^#[0-9a-f]{3}$/i
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i
/**
 * Scheme allowlist for an albedo URL. `data:` is restricted to images so a
 * pasted palette cannot smuggle `data:text/html` into anything that later
 * treats this string as a document source, and everything exotic is dropped.
 */
const SAFE_SCHEME = /^(?:data:image\/|blob:|https?:\/\/|file:\/\/)/i

function isRecord(v: unknown): v is Record<string, unknown> {
  // Arrays are objects but are never a palette or a style.
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Three decimals is finer than any of these values can be perceived at. */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

/**
 * Numeric strings are accepted because a hand-edited or form-serialised
 * palette routinely carries "0.8" instead of 0.8, and rejecting that would
 * silently reset a value the user did set.
 */
function clampNumber(raw: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
  if (!Number.isFinite(n)) return fallback
  return round3(Math.min(hi, Math.max(lo, n)))
}

/** '#abc' is expanded rather than rejected — every other colour tool accepts it. */
function parseHex(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (HEX6.test(s)) return s.toLowerCase()
  if (HEX3.test(s)) {
    const t = s.toLowerCase()
    return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`
  }
  return null
}

function parseTextureUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const url = raw.trim()
  if (!url || url.length > MAX_TEXTURE_URL_CHARS) return null
  // No scheme means a path relative to the app base, which is how the shipped
  // textures under public/ are addressed (see assetOverrides.ts).
  if (!HAS_SCHEME.test(url)) return url
  return SAFE_SCHEME.test(url) ? url : null
}

function parseLabel(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  const s = raw.trim()
  if (!s) return fallback
  return s.length > MAX_LABEL_CHARS ? s.slice(0, MAX_LABEL_CHARS) : s
}

/**
 * One entry, field by field, with the default as the floor. A bad field costs
 * that field only: someone who typed an impossible roughness keeps their colour
 * and their texture.
 */
function parseStyle(raw: unknown, fallback: SurfaceStyle): SurfaceStyle {
  if (!isRecord(raw)) return { ...fallback }
  return {
    label: parseLabel(raw.label, fallback.label),
    color: parseHex(raw.color) ?? fallback.color,
    roughness: clampNumber(raw.roughness, MIN_ROUGHNESS, 1, fallback.roughness),
    metallic: clampNumber(raw.metallic, 0, 1, fallback.metallic),
    // An explicit null means "flat colour", which is a real choice and must not
    // be overwritten by the default's texture; an absent field is not a choice.
    textureUrl: 'textureUrl' in raw ? parseTextureUrl(raw.textureUrl) : fallback.textureUrl,
    tileMetres: clampNumber(raw.tileMetres, MIN_TILE_M, MAX_TILE_M, fallback.tileMetres),
  }
}

/**
 * Rebuild a palette from untrusted JSON.
 *
 * These strings get pasted between people, hand-edited, and carried across
 * versions of the app, so nothing in the input is trusted: the result is
 * constructed key by key from SURFACE_KEYS, which drops unknown keys by never
 * reading them and fills missing ones from the default. Null comes back only
 * when the input is not an object at all — anything that *is* an object yields
 * a usable palette, because a malformed paste must not take the scene down.
 */
export function parsePalette(json: string): Palette | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null

  // Fresh objects throughout: the result is meant to be edited, and it must
  // never share a style object with the frozen default.
  const out = {} as Palette
  for (const key of SURFACE_KEYS) out[key] = parseStyle(raw[key], DEFAULT_PALETTE[key])
  return out
}
