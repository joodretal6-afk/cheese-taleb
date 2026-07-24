import { Rng } from '../engine/math'
import type { RawMap } from './map'

/**
 * Fallback city generator. Used when no real-world map has been baked yet (or
 * when a chosen location turned out to have too little OSM geometry), so the
 * game is always playable offline with a sensible town layout.
 */

interface Block {
  x: number
  y: number
  w: number
  h: number
}

export function generateProceduralMap(seed = 1337, size = 900): RawMap {
  const rng = new Rng(seed)
  const buildings: RawMap['buildings'] = []
  const roads: RawMap['roads'] = []
  const water: RawMap['water'] = []
  const green: RawMap['green'] = []

  const margin = 40
  const usable = size - margin * 2

  // Irregular street grid: column and row widths vary so the town does not
  // read as graph paper.
  const columns = splitAxis(rng, usable, 105, 165)
  const rows = splitAxis(rng, usable, 105, 165)

  const roadWidth = 9
  const xEdges: number[] = [margin]
  for (const w of columns) xEdges.push(xEdges[xEdges.length - 1]! + w)
  const yEdges: number[] = [margin]
  for (const h of rows) yEdges.push(yEdges[yEdges.length - 1]! + h)

  for (const x of xEdges) {
    roads.push({ p: [x, margin - 12, x, size - margin + 12], w: roadWidth, k: 'road' })
  }
  for (const y of yEdges) {
    roads.push({ p: [margin - 12, y, size - margin + 12, y], w: roadWidth, k: 'road' })
  }

  const blocks: Block[] = []
  for (let cx = 0; cx < columns.length; cx++) {
    for (let cy = 0; cy < rows.length; cy++) {
      blocks.push({
        x: xEdges[cx]! + roadWidth / 2 + 4,
        y: yEdges[cy]! + roadWidth / 2 + 4,
        w: columns[cx]! - roadWidth - 8,
        h: rows[cy]! - roadWidth - 8,
      })
    }
  }

  // Reserve a couple of blocks for open space so fights are not all urban.
  const parkIndices = new Set<number>()
  const lakeIndex = rng.int(0, blocks.length - 1)
  parkIndices.add(lakeIndex)
  for (let i = 0; i < 2; i++) parkIndices.add(rng.int(0, blocks.length - 1))

  blocks.forEach((block, index) => {
    if (index === lakeIndex) {
      water.push({ p: blobRing(rng, block.x + block.w / 2, block.y + block.h / 2, Math.min(block.w, block.h) * 0.36) })
      green.push({ p: rect(block.x, block.y, block.w, block.h) })
      return
    }
    if (parkIndices.has(index)) {
      green.push({ p: rect(block.x, block.y, block.w, block.h) })
      scatterTreesAsCover(rng, block, buildings)
      return
    }
    fillBlock(rng, block, buildings)
  })

  return {
    version: 1,
    name: 'مدينة تجريبية — Sandbox City',
    size,
    attribution: 'Procedurally generated',
    buildings,
    roads,
    water,
    green,
  }
}

/** Splits an axis into segments of roughly `min`..`max` length that sum to `total`. */
function splitAxis(rng: Rng, total: number, min: number, max: number): number[] {
  const segments: number[] = []
  let remaining = total
  while (remaining > max) {
    const cut = rng.range(min, max)
    segments.push(cut)
    remaining -= cut
  }
  if (remaining >= min * 0.6) segments.push(remaining)
  else if (segments.length) segments[segments.length - 1]! += remaining
  else segments.push(total)
  return segments
}

/** Fills a city block with a perimeter of buildings plus an inner structure or two. */
function fillBlock(rng: Rng, block: Block, out: RawMap['buildings']): void {
  const style = rng.next()

  if (style < 0.22 && block.w > 60 && block.h > 60) {
    // One large structure covering most of the block: a warehouse or mall.
    const inset = rng.range(6, 14)
    push(out, rect(block.x + inset, block.y + inset, block.w - inset * 2, block.h - inset * 2), rng.range(8, 14), rng.bool() ? 'warehouse' : 'shop')
    return
  }

  // Rows of plots along the block's long axis.
  const horizontal = block.w >= block.h
  const along = horizontal ? block.w : block.h
  const across = horizontal ? block.h : block.w
  const plotDepth = Math.min(across / 2 - 3, rng.range(16, 24))
  const plots = Math.max(2, Math.floor(along / rng.range(16, 26)))
  const plotWidth = along / plots

  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < plots; i++) {
      if (rng.bool(0.16)) continue // gaps: alleys and empty lots

      const pad = rng.range(1.5, 4)
      const w = plotWidth - pad * 2
      const d = plotDepth - rng.range(1, 4)
      if (w < 7 || d < 7) continue

      const alongPos = i * plotWidth + pad
      const acrossPos = side === 0 ? 0 : across - plotDepth

      const x = horizontal ? block.x + alongPos : block.x + acrossPos
      const y = horizontal ? block.y + acrossPos : block.y + alongPos
      const bw = horizontal ? w : d
      const bh = horizontal ? d : w

      const kind = rng.weighted(
        ['house', 'house', 'shop', 'civic', 'generic'] as const,
        (k) => (k === 'house' ? 3 : 1),
      )
      push(out, rect(x, y, bw, bh), rng.range(4, kind === 'civic' ? 18 : 9), kind)
    }
  }

  // Courtyard structure in the middle of deep blocks.
  if (across > plotDepth * 2 + 26 && rng.bool(0.6)) {
    const cw = rng.range(14, 26)
    const ch = rng.range(12, 22)
    const cx = block.x + rng.range(0, Math.max(1, block.w - cw))
    const cy = block.y + (horizontal ? plotDepth + rng.range(4, across - plotDepth * 2 - ch) : rng.range(0, Math.max(1, block.h - ch)))
    push(out, rect(cx, cy, cw, ch), rng.range(5, 10), 'generic')
  }
}

/** Small solid blobs standing in for tree clusters and rocks — cover in open ground. */
function scatterTreesAsCover(rng: Rng, block: Block, out: RawMap['buildings']): void {
  const count = rng.int(3, 7)
  for (let i = 0; i < count; i++) {
    const r = rng.range(2.2, 4.2)
    const cx = block.x + rng.range(r + 4, block.w - r - 4)
    const cy = block.y + rng.range(r + 4, block.h - r - 4)
    push(out, blobRing(rng, cx, cy, r, 6), rng.range(5, 9), 'generic')
  }
}

function rect(x: number, y: number, w: number, h: number): number[] {
  return [x, y, x + w, y, x + w, y + h, x, y + h]
}

/** A closed ring with jittered radii — reads as organic rather than machine-cut. */
function blobRing(rng: Rng, cx: number, cy: number, radius: number, points = 9): number[] {
  const flat: number[] = []
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2
    const r = radius * rng.range(0.75, 1.2)
    flat.push(round(cx + Math.cos(a) * r), round(cy + Math.sin(a) * r))
  }
  return flat
}

function push(out: RawMap['buildings'], p: number[], h: number, k: string): void {
  out.push({ p: p.map(round), h: round(h), k, a: Math.round(shoelace(p)) })
}

function shoelace(flat: number[]): number {
  let area = 0
  const n = flat.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += flat[j * 2]! * flat[i * 2 + 1]! - flat[i * 2]! * flat[j * 2 + 1]!
  }
  return Math.abs(area) / 2
}

const round = (n: number): number => Math.round(n * 100) / 100
