import type { BuildingSideSpec } from './buildingSpec'

/**
 * Draw a façade for a side that has no photo.
 *
 * When the user photographed only the front, the other three walls still need
 * to look like walls — plastered stone with a grid of windows and, on the front,
 * a door. This paints exactly that onto a canvas from the side's spec, so a
 * one-photo building is still a whole building. No AI, no network: it is a few
 * rectangles, but at the right rhythm it reads as a real façade from across a
 * street.
 *
 * Returns a data URL, ready as a Babylon texture.
 */
export function generateFacadeImage(spec: BuildingSideSpec, opts?: { size?: number; aspect?: number }): string {
  const size = opts?.size ?? 512
  // aspect = width / height of the wall, so windows stay square-ish on a wide
  // low wall as much as on a tall narrow one.
  const aspect = opts?.aspect ?? 1
  const w = size
  const h = Math.max(64, Math.round(size / Math.max(0.25, aspect)))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!

  const base = spec.color
  ctx.fillStyle = base
  ctx.fillRect(0, 0, w, h)

  // Faint vertical streaking so flat plaster is not dead-flat under raking sun.
  const [br, bg, bb] = hexToRgb(base)
  for (let x = 0; x < w; x += 3) {
    const n = (pseudo(x * 7 + 3) - 0.5) * 0.08
    ctx.fillStyle = `rgba(${clamp8(br * (1 + n))},${clamp8(bg * (1 + n))},${clamp8(bb * (1 + n))},0.5)`
    ctx.fillRect(x, 0, 3, h)
  }

  const cols = Math.max(1, spec.cols)
  const rows = Math.max(1, spec.rows)
  // Cells with generous margins; the window fills the middle of its cell.
  const cellW = w / cols
  const cellH = h / rows
  const winW = cellW * 0.5
  const winH = cellH * 0.58

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const groundFloor = r === rows - 1
      const isDoor = groundFloor && spec.hasDoor && c === spec.doorCol
      const cx = c * cellW + cellW / 2
      const cy = r * cellH + cellH / 2

      if (isDoor) {
        const dw = cellW * 0.42
        const dh = cellH * 0.82
        drawOpening(ctx, cx - dw / 2, h - dh - cellH * 0.06, dw, dh, '#3a2f26', '#241c16')
      } else {
        drawOpening(ctx, cx - winW / 2, cy - winH / 2, winW, winH, '#2a3742', '#8fb3c9')
      }
    }
  }

  // A thin string course between floors reads as concrete banding, the local
  // vernacular the region buildings already use.
  ctx.fillStyle = `rgba(${clamp8(br * 1.12)},${clamp8(bg * 1.12)},${clamp8(bb * 1.12)},0.6)`
  for (let r = 1; r < rows; r++) ctx.fillRect(0, r * cellH - h * 0.006, w, h * 0.012)

  return canvas.toDataURL('image/png')
}

/** A recessed opening: dark reveal, then the pane/leaf, then a light frame. */
function drawOpening(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  frame: string,
  pane: string,
) {
  ctx.fillStyle = frame
  ctx.fillRect(x - w * 0.06, y - h * 0.06, w * 1.12, h * 1.12)
  ctx.fillStyle = pane
  ctx.fillRect(x, y, w, h)
  // A diagonal glint so glass does not read as flat paint.
  ctx.fillStyle = 'rgba(255,255,255,0.14)'
  ctx.beginPath()
  ctx.moveTo(x, y + h * 0.65)
  ctx.lineTo(x + w * 0.55, y)
  ctx.lineTo(x + w, y)
  ctx.lineTo(x, y + h)
  ctx.closePath()
  ctx.fill()
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function clamp8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}
/** Deterministic hash-noise, so two builds of the same spec look identical. */
function pseudo(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453
  return s - Math.floor(s)
}
