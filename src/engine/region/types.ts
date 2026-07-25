/**
 * Contract for a baked real-world region.
 *
 * Produced by scripts/fetch-region.mjs from OpenStreetMap and AWS Terrain
 * Tiles, then shipped inside public/regions/ so the packaged desktop build has
 * the whole neighbourhood on disk and never touches the network.
 *
 * Everything is already in LOCAL METRES relative to the region centre, with
 * +X east and +Z north, matching the engine's world axes. No projection maths
 * happens at runtime — that is the baker's job.
 */

export interface RegionPoint {
  x: number
  z: number
}

/** OSM highway classes the baker emits, coarsest first. */
export type RoadClass =
  | 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary'
  | 'unclassified' | 'residential' | 'living_street' | 'service'
  | 'track' | 'pedestrian' | 'footway' | 'path' | 'steps'

export interface RegionRoad {
  cls: RoadClass
  /** Half the carriageway width, metres. */
  halfWidth: number
  name?: string
  /** Centreline, at least two points. */
  pts: RegionPoint[]
}

export interface RegionBuilding {
  /** OSM building value, with the useless "yes" mapped to "house". */
  kind: string
  /** Metres. Measured where OSM knows, otherwise inferred from use and area. */
  height: number
  /** Footprint area, m². */
  area: number
  /** Closed ring, first point NOT repeated at the end. */
  ring: RegionPoint[]
}

export interface RegionArea {
  /** landuse value, or 'water'. */
  kind: string
  ring: RegionPoint[]
}

export interface RegionElevation {
  /** Samples per side of the square grid. */
  res: number
  /** Metres above sea level at the lowest sample. */
  minM: number
  maxM: number
  encoding: 'u16-decimetres-base64'
  /** Base64 Uint16, row-major, row 0 = south edge (−Z), column 0 = west (−X). */
  data: string
}

export interface RegionData {
  name: string
  /** Must be shown in-game: OSM is ODbL. */
  attribution: string
  center: { lat: number; lon: number }
  radiusM: number
  /** Full side length of the square, metres. */
  sizeM: number
  elevation: RegionElevation
  roadOrder: RoadClass[]
  roads: RegionRoad[]
  buildings: RegionBuilding[]
  areas: RegionArea[]
}

/**
 * Anything that can answer "how high is the ground here?".
 *
 * MudField takes one of these so the same deformation, physics and character
 * code runs unchanged over either procedural noise or a real neighbourhood.
 */
export interface HeightProvider {
  /** Ground height in metres at a world position, in the engine's frame. */
  heightAt(wx: number, wz: number): number
}

/** Decode the packed elevation grid into plain metres. */
export function decodeElevation(e: RegionElevation): Float32Array {
  const bin = atob(e.data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const u16 = new Uint16Array(bytes.buffer)
  const out = new Float32Array(e.res * e.res)
  for (let i = 0; i < out.length; i++) out[i] = e.minM + u16[i] / 10
  return out
}

/** Total centreline length of a road, metres. */
export function roadLength(road: RegionRoad): number {
  let total = 0
  for (let i = 0; i < road.pts.length - 1; i++) {
    total += Math.hypot(
      road.pts[i + 1].x - road.pts[i].x,
      road.pts[i + 1].z - road.pts[i].z,
    )
  }
  return total
}
