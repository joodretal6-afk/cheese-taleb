#!/usr/bin/env node
/**
 * Builds a playable game map from real OpenStreetMap geometry.
 *
 * Usage:
 *   node tools/fetch-map.mjs --lat 24.7136 --lon 46.6753 --size 900 --name "الرياض"
 *   node tools/fetch-map.mjs --place "Riyadh, Saudi Arabia" --size 900
 *
 * Output: src/data/map.json — buildings, roads, water and green space projected
 * into a flat local metre grid, ready to load with zero runtime network access.
 *
 * Data © OpenStreetMap contributors, licensed under the ODbL. Google Maps data
 * is deliberately NOT used: the Google Maps Platform terms prohibit using their
 * content to build a game map, whereas OSM explicitly permits it with attribution.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = resolve(__dirname, '../src/data/map.json')

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
]

const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
const USER_AGENT = 'ZoneRoyale/1.0 (OSM map baker; contact: via repository issues)'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i++
    }
  }
  return args
}

async function geocode(place) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(place)}&format=json&limit=1`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`Nominatim returned ${res.status}`)
  const results = await res.json()
  if (!results.length) throw new Error(`No place found for "${place}"`)
  return {
    lat: Number(results[0].lat),
    lon: Number(results[0].lon),
    label: results[0].display_name,
  }
}

function buildQuery(bbox) {
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`
  return `[out:json][timeout:120];
(
  way["building"](${bboxStr});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service|pedestrian|footway)$"](${bboxStr});
  way["natural"="water"](${bboxStr});
  way["waterway"="riverbank"](${bboxStr});
  way["landuse"~"^(grass|forest|meadow|recreation_ground|village_green)$"](${bboxStr});
  way["leisure"~"^(park|garden|pitch|playground)$"](${bboxStr});
);
out body geom;`
}

async function overpass(query) {
  let lastError
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      process.stderr.write(`  → querying ${new URL(endpoint).host}\n`)
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: new URLSearchParams({ data: query }).toString(),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      lastError = err
      process.stderr.write(`    failed: ${err.message}\n`)
    }
  }
  throw new Error(`All Overpass endpoints failed. Last error: ${lastError?.message}`)
}

/** Equirectangular projection centred on the map — accurate enough over ~1km. */
function makeProjector(centerLat, centerLon, size) {
  const metresPerDegLat = 111_320
  const metresPerDegLon = 111_320 * Math.cos((centerLat * Math.PI) / 180)
  const half = size / 2
  return (lat, lon) => ({
    // Screen-space y grows downward, so north maps to a smaller y.
    x: (lon - centerLon) * metresPerDegLon + half,
    y: -(lat - centerLat) * metresPerDegLat + half,
  })
}

const ROAD_WIDTHS = {
  motorway: 14,
  trunk: 12,
  primary: 11,
  secondary: 9.5,
  tertiary: 8,
  residential: 7,
  unclassified: 6.5,
  living_street: 6,
  service: 5,
  pedestrian: 4.5,
  footway: 3,
}

function classifyBuilding(tags) {
  const b = tags.building ?? 'yes'
  if (['house', 'detached', 'residential', 'apartments', 'bungalow', 'terrace'].includes(b)) return 'house'
  if (['industrial', 'warehouse', 'factory', 'hangar'].includes(b)) return 'warehouse'
  if (['retail', 'commercial', 'supermarket', 'office'].includes(b)) return 'shop'
  if (['mosque', 'church', 'cathedral', 'temple', 'civic', 'public', 'school', 'university'].includes(b)) return 'civic'
  return 'generic'
}

function estimateHeight(tags) {
  const explicit = Number.parseFloat(tags.height)
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(60, explicit)
  const levels = Number.parseFloat(tags['building:levels'])
  if (Number.isFinite(levels) && levels > 0) return Math.min(60, levels * 3.2)
  return 7
}

/** Shoelace area of a ring in metres². */
function ringArea(points) {
  let area = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += points[j].x * points[i].y - points[i].x * points[j].y
  }
  return Math.abs(area) / 2
}

/** Drops vertices that barely change the outline — OSM rings are far denser than a game needs. */
function simplify(points, tolerance) {
  if (points.length <= 4) return points
  const out = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1]
    const p = points[i]
    if (Math.hypot(p.x - prev.x, p.y - prev.y) >= tolerance) out.push(p)
  }
  const last = points[points.length - 1]
  const prev = out[out.length - 1]
  if (Math.hypot(last.x - prev.x, last.y - prev.y) >= tolerance * 0.5) out.push(last)
  return out
}

const flatten = (points) => points.flatMap((p) => [round(p.x), round(p.y)])
const round = (n) => Math.round(n * 100) / 100

function insideMap(points, size, slack = 30) {
  return points.some((p) => p.x > -slack && p.x < size + slack && p.y > -slack && p.y < size + slack)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const size = Number(args.size ?? 900)
  if (!Number.isFinite(size) || size < 200 || size > 3000) {
    throw new Error('--size must be between 200 and 3000 metres')
  }

  let center
  if (args.place) {
    process.stderr.write(`Geocoding "${args.place}"…\n`)
    center = await geocode(String(args.place))
  } else if (args.lat !== undefined && args.lon !== undefined) {
    center = { lat: Number(args.lat), lon: Number(args.lon), label: args.name ? String(args.name) : null }
  } else {
    throw new Error('Provide either --place "City, Country" or --lat <n> --lon <n>')
  }
  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lon)) {
    throw new Error('Invalid coordinates')
  }

  const displayName = args.name ? String(args.name) : (center.label ?? `${center.lat.toFixed(4)}, ${center.lon.toFixed(4)}`)
  process.stderr.write(`Centre: ${center.lat.toFixed(5)}, ${center.lon.toFixed(5)} — ${size}m square\n`)

  const halfLat = size / 2 / 111_320
  const halfLon = size / 2 / (111_320 * Math.cos((center.lat * Math.PI) / 180))
  const bbox = {
    south: center.lat - halfLat,
    north: center.lat + halfLat,
    west: center.lon - halfLon,
    east: center.lon + halfLon,
  }

  const data = await overpass(buildQuery(bbox))
  const project = makeProjector(center.lat, center.lon, size)

  const buildings = []
  const roads = []
  const water = []
  const green = []

  for (const el of data.elements ?? []) {
    if (el.type !== 'way' || !el.geometry) continue
    const tags = el.tags ?? {}
    const projected = el.geometry.map((g) => project(g.lat, g.lon))
    if (!insideMap(projected, size)) continue

    if (tags.building) {
      const ring = simplify(projected, 1.2)
      if (ring.length < 3) continue
      const area = ringArea(ring)
      // Sub-8m² rings are usually mapping noise (bins, kiosks) and just add cost.
      if (area < 8) continue
      buildings.push({
        p: flatten(ring),
        h: round(estimateHeight(tags)),
        k: classifyBuilding(tags),
        a: Math.round(area),
      })
      continue
    }

    if (tags.highway) {
      const line = simplify(projected, 2.5)
      if (line.length < 2) continue
      roads.push({
        p: flatten(line),
        w: ROAD_WIDTHS[tags.highway] ?? 6,
        k: tags.highway === 'footway' || tags.highway === 'pedestrian' ? 'path' : 'road',
      })
      continue
    }

    if (tags.natural === 'water' || tags.waterway === 'riverbank') {
      const ring = simplify(projected, 2)
      if (ring.length >= 3) water.push({ p: flatten(ring) })
      continue
    }

    if (tags.landuse || tags.leisure) {
      const ring = simplify(projected, 2.5)
      if (ring.length >= 3) green.push({ p: flatten(ring) })
    }
  }

  if (buildings.length === 0) {
    process.stderr.write(
      '\n⚠  No buildings found in this area. The game will fall back to its procedural city.\n' +
        '   Pick a denser urban centre, or increase --size.\n\n',
    )
  }

  const map = {
    version: 1,
    name: displayName,
    size,
    origin: { lat: center.lat, lon: center.lon },
    attribution: '© OpenStreetMap contributors (ODbL)',
    generatedFrom: 'overpass-api.de',
    buildings,
    roads,
    water,
    green,
  }

  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, JSON.stringify(map))
  const sizeKb = Math.round(JSON.stringify(map).length / 1024)

  process.stderr.write(
    `\n✅ Wrote ${OUT_PATH}\n` +
      `   ${buildings.length} buildings · ${roads.length} roads · ${water.length} water · ${green.length} green\n` +
      `   ${sizeKb} KB\n\n`,
  )
}

main().catch((err) => {
  process.stderr.write(`\n❌ ${err.message}\n\n`)
  process.exit(1)
})
