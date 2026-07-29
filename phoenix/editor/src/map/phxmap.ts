/**
 * The `.phxmap` document — the editor's in-memory and on-disk map format.
 *
 * This is the M0 slice of the format described in docs/03-map-editor.md: a JSON
 * manifest carrying metadata, the terrain heightfield, and a list of placed
 * objects (spawns, loot, props). Heavy production maps store the heightfield as
 * a separate 16-bit raster; at this stage we embed a plain float array so a map
 * round-trips through a single JSON file with zero extra tooling.
 */

export const PHX_SCHEMA_VERSION = 1

export type ObjectKind = 'spawn' | 'loot' | 'vehicle' | 'building' | 'tree' | 'rock'

export interface PlacedObject {
  id: string
  kind: ObjectKind
  /** World position in metres (y is ground height, filled at export). */
  x: number
  y: number
  z: number
  /** Yaw in radians. */
  rot: number
  scale: number
}

export interface PhxMapMeta {
  name: string
  schemaVersion: number
  /** Side length of the (square) playable area, in metres. */
  worldSizeMeters: number
  /** Heightfield resolution (vertices per side). */
  grid: number
  /** Maps stored height values (metres) onto the world. */
  heightRange: { min: number; max: number }
}

export interface PhxMap {
  meta: PhxMapMeta
  /** Row-major heightfield, length grid*grid, values in metres. */
  heights: number[]
  objects: PlacedObject[]
}

export function createEmptyMap(name = 'untitled', grid = 256, worldSizeMeters = 2048): PhxMap {
  return {
    meta: {
      name,
      schemaVersion: PHX_SCHEMA_VERSION,
      worldSizeMeters,
      grid,
      heightRange: { min: -50, max: 600 },
    },
    heights: new Array(grid * grid).fill(0),
    objects: [],
  }
}

export function serializeMap(map: PhxMap): string {
  // Round heights to the millimetre so the JSON stays compact.
  const heights = map.heights.map((h) => Math.round(h * 1000) / 1000)
  return JSON.stringify({ ...map, heights }, null, 0)
}

export function parseMap(json: string): PhxMap {
  const raw = JSON.parse(json) as PhxMap
  if (!raw.meta || !Array.isArray(raw.heights)) throw new Error('Not a valid .phxmap file')
  if (raw.meta.schemaVersion > PHX_SCHEMA_VERSION) {
    throw new Error(`Map schema v${raw.meta.schemaVersion} is newer than this editor (v${PHX_SCHEMA_VERSION})`)
  }
  raw.objects ??= []
  return raw
}
