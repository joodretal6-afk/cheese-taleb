import { fbm, ridged, valueNoise2 } from '../engine/noise'

/**
 * Canvas-side texture synthesis for the parts browser and the wear generator.
 *
 * Everything is produced locally and deterministically from a seed, so the
 * dashboard works offline in the packaged desktop build and the same prompt
 * always reproduces the same result. `generateWear` is the local backend for the
 * AI panel — see requestWearTexture() for the hook that swaps in a hosted
 * image model when one is configured.
 */

export type PartShape =
  | 'door' | 'wheel' | 'bumper' | 'glass' | 'light' | 'hood'
  | 'roof' | 'fascia' | 'bed' | 'mirror'

const SHAPE_BY_ID: Record<string, PartShape> = {
  'front-fascia': 'fascia',
  hood: 'hood',
  roof: 'roof',
  'door-fl': 'door',
  'door-fr': 'door',
  'door-rl': 'door',
  'door-rr': 'door',
  'bumper-f': 'bumper',
  'bumper-r': 'bumper',
  bed: 'bed',
  'wheel-fl': 'wheel',
  'wheel-fr': 'wheel',
  'wheel-rl': 'wheel',
  'wheel-rr': 'wheel',
  windshield: 'glass',
  'rear-glass': 'glass',
  mirrors: 'mirror',
  headlights: 'light',
  taillights: 'light',
}

export function shapeForPart(partId: string): PartShape {
  return SHAPE_BY_ID[partId] ?? 'door'
}

export interface WearParams {
  /** 0..1 rust coverage. */
  rust: number
  /** 0..1 mud spatter. */
  mud: number
  /** 0..1 scratches and chips. */
  scratch: number
  /** 0..1 how wet/glossy it reads. */
  wet: number
  /** Base paint colour. */
  paint: [number, number, number]
  seed: number
}

/**
 * Turn a free-text prompt into wear parameters. Arabic and English keywords are
 * both recognised, because the dashboard is Arabic but prompts often mix.
 */
export function paramsFromPrompt(prompt: string, seed: number): WearParams {
  const t = prompt.toLowerCase()
  const has = (...words: string[]) => words.some((w) => t.includes(w))
  const rnd = mulberry(seed)

  let rust = has('صدأ', 'rust', 'corros', 'تآكل') ? 0.55 + rnd() * 0.4 : 0.12 + rnd() * 0.25
  let mud = has('طين', 'وحل', 'mud', 'dirt', 'موحل') ? 0.5 + rnd() * 0.45 : 0.2 + rnd() * 0.3
  let scratch = has('خدوش', 'خدش', 'scratch', 'scrape', 'chip') ? 0.5 + rnd() * 0.4 : 0.15 + rnd() * 0.3
  const wet = has('مبلل', 'رطب', 'wet', 'مطر', 'rain') ? 0.65 + rnd() * 0.3 : 0.2 + rnd() * 0.3

  // Intensity modifiers.
  if (has('خفيف', 'light', 'قليل', 'طفيف')) { rust *= 0.45; mud *= 0.5; scratch *= 0.5 }
  if (has('شديد', 'heavy', 'كثيف', 'قوي', 'عالي الجودة')) { rust = Math.min(1, rust * 1.25) }

  let paint: [number, number, number] = [0.62, 0.6, 0.58]
  if (has('أحمر', 'red')) paint = [0.55, 0.11, 0.1]
  else if (has('أزرق', 'blue')) paint = [0.13, 0.25, 0.48]
  else if (has('أسود', 'black')) paint = [0.09, 0.09, 0.1]
  else if (has('أبيض', 'white')) paint = [0.8, 0.8, 0.79]
  else if (has('أصفر', 'yellow')) paint = [0.78, 0.6, 0.08]
  else if (has('فضي', 'silver', 'رمادي', 'grey', 'gray')) paint = [0.5, 0.51, 0.53]

  return { rust, mud, scratch, wet, paint, seed }
}

/** Small deterministic PRNG so a seed fully reproduces a result. */
function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------- silhouettes

function pathForShape(ctx: CanvasRenderingContext2D, shape: PartShape, w: number, h: number) {
  const p = ctx
  p.beginPath()
  switch (shape) {
    case 'door': {
      const x = w * 0.16, y = h * 0.1, ww = w * 0.68, hh = h * 0.8
      p.roundRect(x, y, ww, hh, [10, 10, 6, 6])
      break
    }
    case 'wheel':
      p.arc(w / 2, h / 2, Math.min(w, h) * 0.4, 0, Math.PI * 2)
      break
    case 'bumper':
      p.roundRect(w * 0.06, h * 0.36, w * 0.88, h * 0.28, 10)
      break
    case 'glass':
      p.moveTo(w * 0.14, h * 0.66)
      p.lineTo(w * 0.3, h * 0.28)
      p.lineTo(w * 0.72, h * 0.28)
      p.lineTo(w * 0.88, h * 0.66)
      p.closePath()
      break
    case 'light':
      p.roundRect(w * 0.14, h * 0.34, w * 0.72, h * 0.3, 8)
      break
    case 'hood':
      p.roundRect(w * 0.08, h * 0.24, w * 0.84, h * 0.5, 12)
      break
    case 'roof':
      p.roundRect(w * 0.12, h * 0.28, w * 0.76, h * 0.42, 8)
      break
    case 'fascia':
      p.roundRect(w * 0.08, h * 0.2, w * 0.84, h * 0.58, 14)
      break
    case 'bed':
      p.roundRect(w * 0.08, h * 0.26, w * 0.84, h * 0.46, 6)
      break
    case 'mirror':
      p.roundRect(w * 0.28, h * 0.36, w * 0.44, h * 0.26, 8)
      break
  }
}

/**
 * Render a part swatch: the silhouette filled with a weathered metal surface.
 * Used for the parts browser tiles and the generated-result thumbnails.
 */
export function renderPart(
  shape: PartShape,
  params: WearParams,
  width = 160,
  height = 120,
): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!

  ctx.clearRect(0, 0, width, height)
  ctx.save()
  pathForShape(ctx, shape, width, height)
  ctx.clip()

  const surface = weatheredSurface(width, height, params, shape)
  ctx.putImageData(surface, 0, 0)
  ctx.restore()

  // Subtle outline so tiles read as objects on the dark panel.
  ctx.save()
  pathForShape(ctx, shape, width, height)
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.restore()

  return canvas.toDataURL('image/png')
}

/** Full-bleed weathered panel — the "generated texture" itself. */
export function generateWear(params: WearParams, width = 256, height = 192): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(weatheredSurface(width, height, params, 'hood'), 0, 0)
  return canvas.toDataURL('image/png')
}

function weatheredSurface(
  w: number,
  h: number,
  params: WearParams,
  shape: PartShape,
): ImageData {
  const img = new ImageData(w, h)
  const s = params.seed
  const isGlass = shape === 'glass'
  const isLight = shape === 'light'
  const isWheel = shape === 'wheel'

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const u = x / w
      const v = y / h

      let r: number, g: number, b: number

      if (isGlass) {
        // Tinted glass with a diagonal highlight.
        const sheen = Math.max(0, 1 - Math.abs(u * 1.4 - v * 0.9 - 0.15) * 3.2)
        r = 0.07 + sheen * 0.5
        g = 0.09 + sheen * 0.55
        b = 0.12 + sheen * 0.6
      } else if (isLight) {
        // Lens: concentric ribbing plus a bright core.
        const dx = (u - 0.5) * 2.4
        const dy = (v - 0.5) * 2.4
        const d = Math.hypot(dx, dy)
        const rib = 0.5 + 0.5 * Math.sin(d * 26)
        const core = Math.max(0, 1 - d * 1.5)
        r = 0.35 + rib * 0.22 + core * 0.55
        g = 0.3 + rib * 0.2 + core * 0.5
        b = 0.26 + rib * 0.18 + core * 0.4
      } else if (isWheel) {
        // Tyre carcass with tread blocks near the rim edge.
        const dx = (u - 0.5) * 2
        const dy = (v - 0.5) * 2
        const d = Math.hypot(dx, dy)
        const ang = Math.atan2(dy, dx)
        const lug = 0.5 + 0.5 * Math.sin(ang * 14)
        const isRim = d < 0.52
        const base = isRim ? 0.34 + lug * 0.05 : 0.08 + lug * 0.05
        r = base
        g = base * (isRim ? 1.0 : 0.98)
        b = base * (isRim ? 1.03 : 0.96)
      } else {
        // Painted steel panel.
        const shade = 0.86 + fbm(u * 3.2, v * 3.2, 3, 2.0, 0.5, s + 5) * 0.28
        r = params.paint[0] * shade
        g = params.paint[1] * shade
        b = params.paint[2] * shade
      }

      if (!isGlass && !isLight) {
        // Rust blooms from edges and low areas.
        const rustField = ridged(u * 5.5, v * 5.5, 4, s + 11)
        const edge = Math.max(0, 1 - Math.min(u, 1 - u, v, 1 - v) * 5)
        const rustMask = Math.max(0, rustField * 1.25 + edge * 0.5 - (1.15 - params.rust))
        if (rustMask > 0) {
          const k = Math.min(1, rustMask * 2.2)
          const rr = 0.42 + rustField * 0.22
          const rg = 0.2 + rustField * 0.12
          const rb = 0.09 + rustField * 0.05
          r += (rr - r) * k
          g += (rg - g) * k
          b += (rb - b) * k
        }

        // Scratches: thin high-frequency streaks.
        const streak = valueNoise2(u * 90 + v * 6, v * 5, s + 29)
        if (streak > 1 - params.scratch * 0.22) {
          const k = 0.55
          r += (0.66 - r) * k
          g += (0.65 - g) * k
          b += (0.63 - b) * k
        }
      }

      // Mud spatter — heavier towards the bottom, as on a real panel.
      const spat = fbm(u * 9, v * 9, 4, 2.1, 0.5, s + 47)
      const gravity = 0.35 + v * 0.9
      const mudMask = Math.max(0, spat * gravity - (1.05 - params.mud))
      if (mudMask > 0) {
        const k = Math.min(0.92, mudMask * 3.0)
        const wetK = 1 - params.wet * 0.45
        r += (0.2 * wetK - r) * k
        g += (0.145 * wetK - g) * k
        b += (0.095 * wetK - b) * k
      }

      // Wet sheen across the top face.
      if (params.wet > 0.3) {
        const gloss = Math.max(0, 1 - Math.abs(v - 0.28) * 4) * (params.wet - 0.3) * 0.5
        r += gloss
        g += gloss
        b += gloss
      }

      img.data[o] = Math.max(0, Math.min(255, r * 255))
      img.data[o + 1] = Math.max(0, Math.min(255, g * 255))
      img.data[o + 2] = Math.max(0, Math.min(255, b * 255))
      img.data[o + 3] = 255
    }
  }
  return img
}

/**
 * The AI panel's backend seam.
 *
 * By default this synthesises the texture locally (offline, deterministic). Set
 * VITE_TEXTURE_API to a service that accepts {prompt, part, seed} and returns
 * {image: "<data or http url>"} to route generation through a real image model
 * instead — the rest of the dashboard does not change.
 */
export async function requestWearTexture(
  prompt: string,
  partId: string,
  seed: number,
): Promise<string> {
  const endpoint = import.meta.env.VITE_TEXTURE_API as string | undefined
  if (endpoint) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, part: partId, seed }),
      })
      if (res.ok) {
        const json = (await res.json()) as { image?: string }
        if (json.image) return json.image
      }
      console.warn('[texture] remote generation failed, falling back to local synthesis')
    } catch (err) {
      console.warn('[texture] remote generation error, falling back to local synthesis', err)
    }
  }
  // Local synthesis. Yielding first keeps the button's pending state visible.
  await new Promise((r) => setTimeout(r, 220))
  return renderPart(shapeForPart(partId), paramsFromPrompt(prompt, seed), 256, 192)
}
