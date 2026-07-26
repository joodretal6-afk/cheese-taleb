import { delight } from './delight'
import type { RGBAImage } from './types'
import {
  fallbackSpec,
  sanitizeSpec,
  SIDES,
  type BuildingSide,
  type BuildingSpec,
} from './buildingSpec'

/**
 * The client half of "photos → 3D building".
 *
 * It never draws geometry and never talks to a model directly. It:
 *   1. de-lights each façade photo, so the wall carries its own colour and not
 *      the harsh side-sun it was shot in — the same de-lighting the texture
 *      studio uses, so a building matches the ground it stands on;
 *   2. sends small thumbnails to the backend, which asks Claude (or the echo
 *      fallback) to read floors, windows, roof, colours and dimensions;
 *   3. sanitises whatever comes back into a spec that cannot break the builder.
 *
 * Everything the model returns is advisory. If the backend is offline, errors,
 * or is the echo provider, a plausible spec is used instead and the user still
 * gets a building. The AI improves the guess; it is never the thing standing
 * between the user and a result.
 */

export interface FacadeInput {
  side: BuildingSide
  image: RGBAImage
}

export interface BuildingResult {
  spec: BuildingSpec
  /** De-lit façade data URLs, aligned to spec.sides[].photoIndex. */
  photos: (string | null)[]
  /** 'ai' when the backend answered, 'local' when we fell back. */
  source: 'ai' | 'local'
}

/** Endpoint of the texture/building backend, same origin var as the texture API. */
const API =
  (import.meta.env?.VITE_BUILDING_API as string | undefined) ??
  (import.meta.env?.VITE_TEXTURE_API as string | undefined)?.replace(/\/generate$/, '/building') ??
  'http://127.0.0.1:8787/building'

/** Longest edge sent to the model. Vision does not need a 12-megapixel wall. */
const THUMB = 512

export async function buildingFromPhotos(
  inputs: FacadeInput[],
  opts?: { delightStrength?: number; signal?: AbortSignal },
): Promise<BuildingResult> {
  const strength = opts?.delightStrength ?? 0.85

  // De-light every façade and turn it into a data URL, one per uploaded photo.
  const photos: string[] = []
  const photoIndexBySide = new Map<BuildingSide, number>()
  const thumbs: { side: BuildingSide; dataUrl: string }[] = []
  for (const input of inputs) {
    const lit = delight(input.image, strength).albedo
    const full = toDataUrl(lit)
    const idx = photos.push(full) - 1
    photoIndexBySide.set(input.side, idx)
    thumbs.push({ side: input.side, dataUrl: toDataUrl(downscale(lit, THUMB)) })
  }

  const photoIndexPerSide = SIDES.map((s) => photoIndexBySide.get(s) ?? null)

  // Ask the backend. Any failure at all falls through to the local spec — the
  // building must not depend on a server being up.
  let spec: BuildingSpec
  let source: 'ai' | 'local' = 'local'
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sides: thumbs.map((t) => ({ side: t.side, image: t.dataUrl })),
      }),
      signal: opts?.signal,
    })
    if (res.ok) {
      const body = (await res.json()) as { spec?: unknown }
      if (body?.spec) {
        spec = sanitizeSpec(body.spec, photos.length)
        // The model does not know our photo indices; bind each side to the photo
        // the user actually gave for it, overriding whatever it guessed.
        for (const s of spec.sides) s.photoIndex = photoIndexBySide.get(s.side) ?? null
        source = 'ai'
        return { spec, photos, source }
      }
    }
  } catch {
    // network/abort/parse — fall through to local.
  }

  spec = fallbackSpec(photoIndexPerSide)
  return { spec, photos, source }
}

// ------------------------------------------------------------------ raster IO

function toDataUrl(img: RGBAImage): string {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)
  return canvas.toDataURL('image/png')
}

/** Box-filtered downscale so the longest edge is at most `max`. */
function downscale(img: RGBAImage, max: number): RGBAImage {
  const scale = Math.min(1, max / Math.max(img.width, img.height))
  if (scale >= 1) return img
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const src = document.createElement('canvas')
  src.width = img.width
  src.height = img.height
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)
  const dst = document.createElement('canvas')
  dst.width = w
  dst.height = h
  const dctx = dst.getContext('2d')!
  dctx.imageSmoothingEnabled = true
  dctx.imageSmoothingQuality = 'high'
  dctx.drawImage(src, 0, 0, w, h)
  const out = dctx.getImageData(0, 0, w, h)
  return { width: w, height: h, data: out.data }
}
