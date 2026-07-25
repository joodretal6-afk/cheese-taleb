/**
 * Bakes a real-world area into a region file the engine can load offline.
 *
 * Pulls two independent public datasets and fuses them into one file:
 *   - OpenStreetMap (Overpass API) — road centrelines and building footprints
 *   - AWS Terrain Tiles            — real ground elevation, ~8 m per sample
 *
 * The output is written into public/regions/, so the packaged desktop build
 * ships the terrain with it and never touches the network at runtime.
 *
 *   node scripts/fetch-region.mjs --lat 32.18949 --lon 36.31704 \
 *        --radius 1000 --name khalidiya
 *
 * OSM data is ODbL: anything shipped using it must credit OpenStreetMap.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { dirname } from 'node:path'

// ---------------------------------------------------------------------- args

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
}
const LAT = Number(args.lat ?? 32.18949)
const LON = Number(args.lon ?? 36.31704)
/** Half-width of the square, metres. */
const RADIUS = Number(args.radius ?? 1000)
const NAME = args.name ?? 'region'
const ZOOM = Number(args.zoom ?? 14)
const OUT = args.out ?? `public/regions/${NAME}.json`

// Overpass mirrors, tried in order — the main instance rate-limits aggressively.
const OVERPASS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
]

const MPD_LAT = 111320 // metres per degree of latitude
const mpdLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180)

/**
 * Local tangent-plane projection: metres east/north of the region centre.
 * At latitude 32 a degree of longitude is only 94 km, not 111 — using a single
 * factor for both axes would squash the whole neighbourhood sideways.
 */
const toLocal = (lat, lon) => ({
  x: (lon - LON) * mpdLon(LAT),
  z: (lat - LAT) * MPD_LAT,
})

// ------------------------------------------------------------------ png decode

/** Minimal PNG reader for 8-bit RGB/RGBA — avoids pulling in an image library. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  let bitDepth = 0
  const idat = []

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: depth=${bitDepth} colorType=${colorType}`)
  }

  const channels = colorType === 2 ? 3 : 4
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)

  // Undo per-scanline filtering (PNG spec section 9).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[i] = v & 0xff
    }
  }
  return { width, height, channels, data: out }
}

// ------------------------------------------------------------------- elevation

const deg2tile = (lat, lon, z) => {
  const n = 2 ** z
  return [
    ((lon + 180) / 360) * n,
    ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n,
  ]
}

async function fetchElevation(res) {
  const dLat = RADIUS / MPD_LAT
  const dLon = RADIUS / mpdLon(LAT)

  const corners = [
    [LAT - dLat, LON - dLon],
    [LAT + dLat, LON + dLon],
  ].map(([la, lo]) => deg2tile(la, lo, ZOOM))
  const x0 = Math.floor(Math.min(corners[0][0], corners[1][0]))
  const x1 = Math.floor(Math.max(corners[0][0], corners[1][0]))
  const y0 = Math.floor(Math.min(corners[0][1], corners[1][1]))
  const y1 = Math.floor(Math.max(corners[0][1], corners[1][1]))

  const tiles = new Map()
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${x}/${y}.png`
      const r = await fetch(url)
      if (!r.ok) throw new Error(`elevation tile ${x}/${y}: HTTP ${r.status}`)
      tiles.set(`${x}/${y}`, decodePng(Buffer.from(await r.arrayBuffer())))
      process.stderr.write(`  tile ${x}/${y}\r`)
    }
  }
  process.stderr.write(`  ${tiles.size} elevation tiles\n`)

  const sample = (lat, lon) => {
    const [fx, fy] = deg2tile(lat, lon, ZOOM)
    const img = tiles.get(`${Math.floor(fx)}/${Math.floor(fy)}`)
    if (!img) return null
    const px = Math.min(img.width - 1, Math.floor((fx % 1) * img.width))
    const py = Math.min(img.height - 1, Math.floor((fy % 1) * img.height))
    const i = (py * img.width + px) * img.channels
    // Terrarium encoding: metres = (R*256 + G + B/256) - 32768
    return img.data[i] * 256 + img.data[i + 1] + img.data[i + 2] / 256 - 32768
  }

  // Regular grid in LOCAL METRES, so the engine never re-projects at runtime.
  const heights = new Float32Array(res * res)
  let min = Infinity
  let max = -Infinity
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const z = (j / (res - 1) - 0.5) * 2 * RADIUS
      const x = (i / (res - 1) - 0.5) * 2 * RADIUS
      const lat = LAT + z / MPD_LAT
      const lon = LON + x / mpdLon(LAT)
      const e = sample(lat, lon) ?? 0
      heights[j * res + i] = e
      if (e < min) min = e
      if (e > max) max = e
    }
  }
  return { heights, min, max, res }
}

// ------------------------------------------------------------------------ osm

async function fetchOsm() {
  const dLat = RADIUS / MPD_LAT
  const dLon = RADIUS / mpdLon(LAT)
  const bbox = [LAT - dLat, LON - dLon, LAT + dLat, LON + dLon]
    .map((v) => v.toFixed(6))
    .join(',')

  const query = `[out:json][timeout:120];
(
  way["highway"](${bbox});
  way["building"](${bbox});
  way["landuse"](${bbox});
  way["natural"="water"](${bbox});
);
out geom;`

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let lastError = null

  // Overpass is a free shared service: it rate-limits hard and rejects requests
  // that do not identify themselves. Both are worth handling properly rather
  // than hammering it.
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const host of OVERPASS) {
      try {
        const r = await fetch(host, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
            'user-agent': 'mud-terrain-simulator/0.1 (region baker; github.com/joodretal6-afk/cheese-taleb)',
          },
          body: new URLSearchParams({ data: query }),
        })
        if (r.status === 429 || r.status === 504) throw new Error(`HTTP ${r.status} (busy)`)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const text = await r.text()
        const json = JSON.parse(text)
        const n = json.elements?.length ?? 0
        if (n === 0) throw new Error('returned 0 elements')
        process.stderr.write(`  overpass: ${host.split('/')[2]} → ${n} elements\n`)
        return json.elements
      } catch (err) {
        lastError = err
        process.stderr.write(`  overpass ${host.split('/')[2]} failed: ${err.message}\n`)
      }
    }
    const wait = 20000 * (attempt + 1)
    process.stderr.write(`  all mirrors busy, waiting ${wait / 1000}s…\n`)
    await sleep(wait)
  }
  throw lastError ?? new Error('all Overpass mirrors failed')
}

/** Road half-widths in metres, by OSM highway class. */
const ROAD_WIDTH = {
  motorway: 7, trunk: 6, primary: 5.5, secondary: 4.5, tertiary: 4,
  unclassified: 3.2, residential: 3, service: 2.4, living_street: 3,
  track: 2.2, path: 0.9, footway: 0.9, pedestrian: 1.6, steps: 0.8,
}
const ROAD_ORDER = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street', 'service', 'track',
  'pedestrian', 'footway', 'path', 'steps']

function classifyRoad(tags) {
  const h = tags.highway
  if (ROAD_WIDTH[h] !== undefined) return h
  if (h?.endsWith('_link')) return h.replace('_link', '')
  return 'service'
}

/** Storeys → metres. A residential floor is about 3 m floor-to-floor. */
function buildingHeight(tags, areaM2) {
  const explicit = parseFloat(tags.height)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const levels = parseFloat(tags['building:levels'])
  if (Number.isFinite(levels) && levels > 0) return levels * 3.1
  // No data at all — guess from footprint area and use, which is what most of
  // this area needs. Small footprint = house; large = apartment block or shed.
  const kind = tags.building
  if (kind === 'garage' || kind === 'shed' || kind === 'hut') return 2.8
  if (kind === 'apartments') return 12
  if (kind === 'commercial' || kind === 'retail') return 6
  if (areaM2 > 600) return 9
  if (areaM2 > 250) return 6.2
  return 3.4
}

/** Shoelace area of a projected ring, m². */
function ringArea(pts) {
  let a = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].z - pts[i].z)
  }
  return Math.abs(a) / 2
}

// ----------------------------------------------------------------------- main

process.stderr.write(`Baking region "${NAME}" at ${LAT}, ${LON} (±${RADIUS} m)\n`)

const elements = await fetchOsm()

const roads = []
const buildings = []
const areas = []

for (const el of elements) {
  const g = el.geometry
  if (!g || g.length < 2) continue
  const tags = el.tags ?? {}
  const pts = g.map((p) => {
    const l = toLocal(p.lat, p.lon)
    return { x: Math.round(l.x * 100) / 100, z: Math.round(l.z * 100) / 100 }
  })

  if (tags.highway) {
    const cls = classifyRoad(tags)
    roads.push({
      cls,
      halfWidth: ROAD_WIDTH[cls] ?? 3,
      name: tags['name:ar'] || tags.name || undefined,
      // A road drawn as a closed loop still renders as a ribbon, not a polygon.
      pts,
    })
  } else if (tags.building) {
    // Footprints must be closed rings; Overpass repeats the first node.
    const ring = pts.length > 2 && pts[0].x === pts.at(-1).x && pts[0].z === pts.at(-1).z
      ? pts.slice(0, -1)
      : pts
    if (ring.length < 3) continue
    const area = ringArea(ring)
    if (area < 8) continue // stray fragments
    buildings.push({
      kind: tags.building === 'yes' ? 'house' : tags.building,
      height: Math.round(buildingHeight(tags, area) * 10) / 10,
      area: Math.round(area),
      ring,
    })
  } else if (tags.landuse || tags.natural) {
    areas.push({ kind: tags.natural === 'water' ? 'water' : tags.landuse, ring: pts })
  }
}

process.stderr.write(`  roads: ${roads.length}  buildings: ${buildings.length}  areas: ${areas.length}\n`)

// Elevation grid. 4 m per sample is finer than the source (~8 m) but keeps the
// bilinear surface smooth where roads cut across it.
const demRes = Math.min(513, Math.max(129, Math.round((RADIUS * 2) / 4) | 1))
const dem = await fetchElevation(demRes)

// Uint16 decimetres relative to the minimum: 6.5 km of range at 10 cm precision,
// a quarter the size of Float32 and far smaller than JSON numbers.
const quantised = new Uint16Array(dem.heights.length)
for (let i = 0; i < dem.heights.length; i++) {
  quantised[i] = Math.max(0, Math.min(65535, Math.round((dem.heights[i] - dem.min) * 10)))
}

const region = {
  name: NAME,
  attribution: '© OpenStreetMap contributors (ODbL) · Elevation: AWS Terrain Tiles / NASA SRTM',
  center: { lat: LAT, lon: LON },
  radiusM: RADIUS,
  sizeM: RADIUS * 2,
  elevation: {
    res: demRes,
    minM: Math.round(dem.min * 100) / 100,
    maxM: Math.round(dem.max * 100) / 100,
    /** decimetres above minM, row-major, row 0 = south edge (-Z). */
    encoding: 'u16-decimetres-base64',
    data: Buffer.from(quantised.buffer).toString('base64'),
  },
  roadOrder: ROAD_ORDER,
  roads,
  buildings,
  areas,
}

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, JSON.stringify(region))

const bytes = Buffer.byteLength(JSON.stringify(region))
process.stderr.write(
  `\nWrote ${OUT}  (${(bytes / 1024 / 1024).toFixed(2)} MB)\n` +
    `  elevation ${demRes}×${demRes} @ ${((RADIUS * 2) / demRes).toFixed(1)} m/sample\n` +
    `  relief ${dem.min.toFixed(0)}–${dem.max.toFixed(0)} m (${(dem.max - dem.min).toFixed(0)} m)\n`,
)
