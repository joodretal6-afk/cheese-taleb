/**
 * Shared contracts for the photo → game-asset pipeline.
 *
 * Everything downstream works on plain RGBA buffers rather than canvases or
 * DOM images, so each stage is a pure function that runs identically in the
 * browser, in a worker, and in Node for tests.
 */

export interface Pt {
  x: number
  y: number
}

/** Plain RGBA8 raster. `data.length === width * height * 4`. */
export interface RGBAImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** Four source-pixel corners, in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt]

/** The PBR set a game material needs. All maps share one resolution. */
export interface PbrMaps {
  /** Base colour with lighting removed. */
  albedo: RGBAImage
  /** Tangent-space normal, RGB encoded (0.5,0.5,1) = flat. */
  normal: RGBAImage
  /** Greyscale roughness. */
  roughness: RGBAImage
  /** Greyscale ambient occlusion. */
  ao: RGBAImage
  /** Greyscale height/displacement. */
  height: RGBAImage
}

/** A region of a source photo that becomes one material. */
export interface PhotoRegion {
  id: string
  /** Human label, e.g. "باب" or "جدار". */
  label: string
  /** Corners in the source image, for perspective correction. */
  quad: Quad
  /** Suggested material kind, used to pick sensible processing defaults. */
  kind: MaterialKind
}

export type MaterialKind =
  | 'wall' | 'door' | 'window' | 'ground' | 'rock' | 'wood' | 'metal' | 'fabric' | 'unknown'

export interface ProcessOptions {
  /** Output edge length in pixels. Powers of two keep mipmapping happy. */
  size: 512 | 1024 | 2048 | 4096 | 8192
  /** 0..1 — how aggressively baked lighting is removed. */
  delightStrength: number
  /** Make the result tile seamlessly. Off for one-off decals like a single door. */
  tileable: boolean
  /** 0..1 — relief strength for the derived normal map. */
  reliefStrength: number
  /** Physical width of the photographed area in metres, for correct tiling scale. */
  realWorldWidthM: number
}

export const DEFAULT_PROCESS: ProcessOptions = {
  size: 1024,
  delightStrength: 0.75,
  tileable: true,
  reliefStrength: 1,
  realWorldWidthM: 2,
}

// ---------------------------------------------------------------- primitives

export function createImage(width: number, height: number): RGBAImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}

export function cloneImage(src: RGBAImage): RGBAImage {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) }
}

/** Nearest-neighbour fetch with edge clamping. */
export function getPixel(img: RGBAImage, x: number, y: number, out: number[]): void {
  const cx = x < 0 ? 0 : x >= img.width ? img.width - 1 : x | 0
  const cy = y < 0 ? 0 : y >= img.height ? img.height - 1 : y | 0
  const i = (cy * img.width + cx) * 4
  out[0] = img.data[i]
  out[1] = img.data[i + 1]
  out[2] = img.data[i + 2]
  out[3] = img.data[i + 3]
}

/** Bilinear fetch with edge clamping; `fx`/`fy` are in pixel units. */
export function sampleBilinear(img: RGBAImage, fx: number, fy: number, out: number[]): void {
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const a: number[] = [0, 0, 0, 0]
  const b: number[] = [0, 0, 0, 0]
  const c: number[] = [0, 0, 0, 0]
  const d: number[] = [0, 0, 0, 0]
  getPixel(img, x0, y0, a)
  getPixel(img, x0 + 1, y0, b)
  getPixel(img, x0, y0 + 1, c)
  getPixel(img, x0 + 1, y0 + 1, d)
  for (let k = 0; k < 4; k++) {
    out[k] = (a[k] * (1 - tx) + b[k] * tx) * (1 - ty) + (c[k] * (1 - tx) + d[k] * tx) * ty
  }
}

export function setPixel(img: RGBAImage, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return
  const i = (y * img.width + x) * 4
  img.data[i] = r
  img.data[i + 1] = g
  img.data[i + 2] = b
  img.data[i + 3] = a
}

/** Perceptual luminance, 0..255. */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Greyscale plane extracted from an image, 0..1 floats. */
export function toLumaPlane(img: RGBAImage): Float32Array {
  const out = new Float32Array(img.width * img.height)
  for (let i = 0, p = 0; i < img.data.length; i += 4, p++) {
    out[p] = luma(img.data[i], img.data[i + 1], img.data[i + 2]) / 255
  }
  return out
}

/** Wrap a 0..1 float plane back into a greyscale RGBA image. */
export function fromPlane(plane: Float32Array, width: number, height: number): RGBAImage {
  const img = createImage(width, height)
  for (let p = 0, i = 0; p < plane.length; p++, i += 4) {
    const v = Math.max(0, Math.min(255, plane[p] * 255))
    img.data[i] = v
    img.data[i + 1] = v
    img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  return img
}

/** Separable box blur on a float plane — the workhorse for large-radius passes. */
export function blurPlane(plane: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius < 1) return plane.slice()
  const tmp = new Float32Array(plane.length)
  const out = new Float32Array(plane.length)
  const r = Math.round(radius)
  const norm = 1 / (r * 2 + 1)

  for (let y = 0; y < height; y++) {
    const row = y * width
    let acc = 0
    for (let x = -r; x <= r; x++) acc += plane[row + Math.min(width - 1, Math.max(0, x))]
    for (let x = 0; x < width; x++) {
      tmp[row + x] = acc * norm
      const add = plane[row + Math.min(width - 1, x + r + 1)]
      const sub = plane[row + Math.max(0, x - r)]
      acc += add - sub
    }
  }
  for (let x = 0; x < width; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(height - 1, Math.max(0, y)) * width + x]
    for (let y = 0; y < height; y++) {
      out[y * width + x] = acc * norm
      const add = tmp[Math.min(height - 1, y + r + 1) * width + x]
      const sub = tmp[Math.max(0, y - r) * width + x]
      acc += add - sub
    }
  }
  return out
}

/** Encode an RGBAImage as a PNG data URL. Browser only. */
export function toDataURL(img: RGBAImage, type = 'image/png', quality?: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')!
  // Build via createImageData and copy: the ImageData constructor demands a
  // Uint8ClampedArray<ArrayBuffer>, which our ArrayBufferLike-backed buffers
  // don't satisfy under TS's DOM lib.
  const id = ctx.createImageData(img.width, img.height)
  id.data.set(img.data)
  ctx.putImageData(id, 0, 0)
  return canvas.toDataURL(type, quality)
}

/** Decode a File/Blob/data URL into an RGBAImage. Browser only. */
export async function loadImage(source: Blob | string): Promise<RGBAImage> {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source)
  try {
    const bitmap = await createImageBitmap(
      typeof source === 'string' ? await (await fetch(url)).blob() : source,
    )
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height)
    return { width: id.width, height: id.height, data: id.data }
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url)
  }
}
