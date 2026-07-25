/**
 * The contract between "AI looked at some façade photos" and "code builds a 3D
 * building".
 *
 * Claude (or the deterministic fallback) never produces geometry. It produces
 * THIS: how big the building is, how many floors, what the roof is, and for
 * every side, either "use photo N" or a description of a façade to draw. The
 * builder turns that into a mesh. Keeping the boundary here means the AI half
 * and the geometry half are testable apart, and a bad answer from the model is
 * a validation failure, not a broken mesh.
 */

export type BuildingSide = 'front' | 'back' | 'left' | 'right'
export const SIDES: BuildingSide[] = ['front', 'back', 'left', 'right']

export type RoofKind = 'flat' | 'parapet' | 'pitched'

export interface BuildingSideSpec {
  side: BuildingSide
  /** Index into the uploaded photos that textures this side, or null. */
  photoIndex: number | null
  /** Wall colour for a side with no photo, '#rrggbb'. */
  color: string
  /** Window columns across the façade. */
  cols: number
  /** Window rows — usually the floor count. */
  rows: number
  hasDoor: boolean
  /** 0-based column the ground-floor door sits in. */
  doorCol: number
}

export interface BuildingSpec {
  /** Front width, metres. */
  widthM: number
  /** Side depth, metres. */
  depthM: number
  floors: number
  floorHeightM: number
  roof: RoofKind
  roofColor: string
  /** Fallback wall colour, used where a side gives none. */
  wallColor: string
  sides: BuildingSideSpec[]
}

const clampNum = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : d
  return Math.min(hi, Math.max(lo, n))
}

const HEX = /^#[0-9a-fA-F]{6}$/
const asColor = (v: unknown, d: string): string => (typeof v === 'string' && HEX.test(v) ? v : d)

/**
 * Coerce whatever the provider returned into a spec that cannot break the
 * builder: every number in range, four sides present, colours valid. A model
 * that hallucinates 900 floors gets clamped, not trusted.
 */
export function sanitizeSpec(raw: unknown, photoCount: number): BuildingSpec {
  const o = (raw ?? {}) as Record<string, unknown>
  const floors = clampNum(o.floors, 1, 40, 2)
  const wallColor = asColor(o.wallColor, '#d8c7a4')

  const byName = new Map<BuildingSide, Record<string, unknown>>()
  if (Array.isArray(o.sides)) {
    for (const s of o.sides as Record<string, unknown>[]) {
      const name = s?.side as BuildingSide
      if (SIDES.includes(name)) byName.set(name, s)
    }
  }

  const sides: BuildingSideSpec[] = SIDES.map((side) => {
    const s = byName.get(side) ?? {}
    let photoIndex: number | null = null
    if (typeof s.photoIndex === 'number' && s.photoIndex >= 0 && s.photoIndex < photoCount) {
      photoIndex = Math.floor(s.photoIndex)
    }
    const cols = clampNum(s.cols, 1, 20, 3)
    return {
      side,
      photoIndex,
      color: asColor(s.color, wallColor),
      cols,
      rows: clampNum(s.rows, 1, 40, floors),
      hasDoor: !!s.hasDoor,
      doorCol: clampNum(s.doorCol, 0, cols - 1, Math.floor(cols / 2)),
    }
  })

  // A building has to have a way in. If the model marked no door anywhere, put
  // one on the front — the side most likely to have been photographed.
  if (!sides.some((s) => s.hasDoor)) {
    const front = sides[0]
    front.hasDoor = true
    front.doorCol = Math.floor(front.cols / 2)
  }

  return {
    widthM: clampNum(o.widthM, 3, 60, 9),
    depthM: clampNum(o.depthM, 3, 60, 9),
    floors,
    floorHeightM: clampNum(o.floorHeightM, 2.4, 5, 3.05),
    roof: (['flat', 'parapet', 'pitched'] as RoofKind[]).includes(o.roof as RoofKind)
      ? (o.roof as RoofKind)
      : 'parapet',
    roofColor: asColor(o.roofColor, '#b0aca3'),
    wallColor,
    sides,
  }
}

/**
 * A plausible spec with no AI at all, from just the photo count.
 *
 * This is the honest floor under the feature: if the backend is the echo
 * provider, or offline, or the model errors, the user still gets a building —
 * a sensible two-to-three storey box with the photos mapped to whatever sides
 * they said they had. The AI only ever improves this, never gates it.
 */
export function fallbackSpec(sidesWithPhotos: (number | null)[]): BuildingSpec {
  const floors = 3
  const sides: BuildingSideSpec[] = SIDES.map((side, i) => ({
    side,
    photoIndex: sidesWithPhotos[i] ?? null,
    color: '#d8c7a4',
    cols: 3,
    rows: floors,
    hasDoor: side === 'front',
    doorCol: 1,
  }))
  return {
    widthM: 9,
    depthM: 9,
    floors,
    floorHeightM: 3.05,
    roof: 'parapet',
    roofColor: '#b0aca3',
    wallColor: '#d8c7a4',
    sides,
  }
}
