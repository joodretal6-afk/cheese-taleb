/**
 * Turns a flat generated image into a usable PBR material set.
 *
 * An image generator gives you colour and nothing else. Colour alone renders
 * as a sticker: no relief, uniform shine, and a visible seam wherever the
 * texture repeats. The three passes here recover the missing channels from the
 * albedo itself — approximations, but ones that read convincingly under moving
 * light, which is what matters in a game.
 */

export interface PbrMaps {
  albedo: HTMLCanvasElement
  normal: HTMLCanvasElement
  roughness: HTMLCanvasElement
}

export interface PipelineOptions {
  /** Strength of the derived relief. 0 disables the normal map entirely. */
  normalStrength: number
  /** Blur applied to the height estimate before differencing, in pixels. */
  heightSmoothing: number
  /** Maps luminance to gloss. Higher means dark areas read as wetter. */
  roughnessContrast: number
  /** Baseline roughness before the albedo modulates it. */
  roughnessBase: number
  /** Feather width for seamless tiling, as a fraction of the image. 0 disables. */
  seamlessBlend: number
  /** Invert the height reading — useful when a texture's mortar reads dark. */
  invertHeight: boolean
}

export const DEFAULT_PIPELINE_OPTIONS: PipelineOptions = {
  normalStrength: 2.4,
  heightSmoothing: 1.2,
  roughnessContrast: 0.75,
  roughnessBase: 0.62,
  seamlessBlend: 0.14,
  invertHeight: false,
}

/** Perceptual luminance — matching how the eye reads brightness matters here. */
const luminance = (r: number, g: number, b: number): number =>
  (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

export function generatePbrMaps(
  source: HTMLImageElement | HTMLCanvasElement,
  options: Partial<PipelineOptions> = {},
): PbrMaps {
  const opts = { ...DEFAULT_PIPELINE_OPTIONS, ...options }
  const size = clampToPowerOfTwo(
    'naturalWidth' in source ? source.naturalWidth : source.width,
    'naturalHeight' in source ? source.naturalHeight : source.height,
  )

  const albedo = drawToCanvas(source, size, size)
  if (opts.seamlessBlend > 0) makeSeamless(albedo, opts.seamlessBlend)

  const height = extractHeight(albedo, opts)
  const normal = heightToNormal(height, size, opts.normalStrength)
  const roughness = albedoToRoughness(albedo, opts)

  return { albedo, normal, roughness }
}

/**
 * GPUs sample power-of-two textures more cheaply and mipmap them without a
 * resize, so anything a generator hands us gets snapped to the nearest one.
 */
function clampToPowerOfTwo(width: number, height: number): number {
  const largest = Math.max(width, height, 64)
  const capped = Math.min(largest, 2048)
  return 2 ** Math.round(Math.log2(capped))
}

function drawToCanvas(
  source: HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, width, height)
  return canvas
}

/**
 * Cross-fades the image against a half-offset copy of itself so that the tile's
 * left edge matches its right, and top matches bottom.
 *
 * Offsetting moves the discontinuity into the middle of the image where a
 * feathered blend can hide it; the outer edges, which are what actually meet
 * when the texture repeats, come from continuous interior pixels.
 */
export function makeSeamless(canvas: HTMLCanvasElement, blendFraction: number): void {
  const { width, height } = canvas
  const ctx = canvas.getContext('2d')!
  const original = ctx.getImageData(0, 0, width, height)

  // Half-offset copy, wrapping around both axes.
  const shifted = ctx.createImageData(width, height)
  const halfW = width >> 1
  const halfH = height >> 1
  for (let y = 0; y < height; y++) {
    const sy = (y + halfH) % height
    for (let x = 0; x < width; x++) {
      const sx = (x + halfW) % width
      const from = (sy * width + sx) * 4
      const to = (y * width + x) * 4
      shifted.data[to] = original.data[from]!
      shifted.data[to + 1] = original.data[from + 1]!
      shifted.data[to + 2] = original.data[from + 2]!
      shifted.data[to + 3] = 255
    }
  }

  const feather = Math.max(2, Math.floor(Math.min(width, height) * blendFraction))
  const output = ctx.createImageData(width, height)

  for (let y = 0; y < height; y++) {
    // Distance from the seam the offset introduced, down the middle.
    const dy = Math.abs(y - halfH)
    const wy = dy < feather ? smoothstep(dy / feather) : 1
    for (let x = 0; x < width; x++) {
      const dx = Math.abs(x - halfW)
      const wx = dx < feather ? smoothstep(dx / feather) : 1
      // Near the introduced seam, favour the shifted copy (whose pixels there
      // came from the original's continuous interior).
      const blend = Math.min(wx, wy)
      const i = (y * width + x) * 4
      for (let c = 0; c < 3; c++) {
        output.data[i + c] = Math.round(
          original.data[i + c]! * blend + shifted.data[i + c]! * (1 - blend),
        )
      }
      output.data[i + 3] = 255
    }
  }

  ctx.putImageData(output, 0, 0)
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t)

/** Luminance as a height field, lightly blurred so noise does not become relief. */
function extractHeight(canvas: HTMLCanvasElement, opts: PipelineOptions): Float32Array {
  const { width, height } = canvas
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data
  const raw = new Float32Array(width * height)

  for (let i = 0, p = 0; i < raw.length; i++, p += 4) {
    const l = luminance(data[p]!, data[p + 1]!, data[p + 2]!)
    raw[i] = opts.invertHeight ? 1 - l : l
  }

  const radius = Math.max(0, Math.round(opts.heightSmoothing))
  return radius === 0 ? raw : boxBlurWrapped(raw, width, height, radius)
}

/** Separable box blur that wraps at the edges, preserving tileability. */
function boxBlurWrapped(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const pass1 = new Float32Array(src.length)
  const window = radius * 2 + 1

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) {
        sum += src[row + ((x + k + width) % width)]!
      }
      pass1[row + x] = sum / window
    }
  }

  const pass2 = new Float32Array(src.length)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) {
        sum += pass1[((y + k + height) % height) * width + x]!
      }
      pass2[y * width + x] = sum / window
    }
  }
  return pass2
}

/**
 * Sobel gradients of the height field become a tangent-space normal map.
 * Wrapping the sampling keeps the normal map as tileable as its source.
 */
function heightToNormal(height: Float32Array, size: number, strength: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(size, size)

  const at = (x: number, y: number): number =>
    height[((y + size) % size) * size + ((x + size) % size)]!

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1)
      const t = at(x, y - 1)
      const tr = at(x + 1, y - 1)
      const l = at(x - 1, y)
      const r = at(x + 1, y)
      const bl = at(x - 1, y + 1)
      const b = at(x, y + 1)
      const br = at(x + 1, y + 1)

      const dx = tl + 2 * l + bl - (tr + 2 * r + br)
      const dy = tl + 2 * t + tr - (bl + 2 * b + br)

      let nx = dx * strength
      let ny = dy * strength
      let nz = 1
      const inv = 1 / Math.hypot(nx, ny, nz)
      nx *= inv
      ny *= inv
      nz *= inv

      const i = (y * size + x) * 4
      image.data[i] = Math.round((nx + 1) * 127.5)
      image.data[i + 1] = Math.round((ny + 1) * 127.5)
      image.data[i + 2] = Math.round((nz + 1) * 127.5)
      image.data[i + 3] = 255
    }
  }

  ctx.putImageData(image, 0, 0)
  return canvas
}

/**
 * Estimates roughness from albedo. The heuristic: darker and more saturated
 * regions tend to be wet, polished or shadowed, so they get glossier; bright
 * desaturated regions read as dust and chalk, so they stay matte.
 */
function albedoToRoughness(canvas: HTMLCanvasElement, opts: PipelineOptions): HTMLCanvasElement {
  const { width, height } = canvas
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data

  const output = document.createElement('canvas')
  output.width = width
  output.height = height
  const ctx = output.getContext('2d')!
  const image = ctx.createImageData(width, height)

  for (let i = 0, p = 0; p < data.length; i++, p += 4) {
    const r = data[p]!
    const g = data[p + 1]!
    const b = data[p + 2]!
    const l = luminance(r, g, b)
    const maxC = Math.max(r, g, b)
    const saturation = maxC === 0 ? 0 : (maxC - Math.min(r, g, b)) / maxC

    let roughness = opts.roughnessBase + (l - 0.5) * opts.roughnessContrast
    roughness -= saturation * 0.12
    roughness = Math.max(0.04, Math.min(1, roughness))

    const value = Math.round(roughness * 255)
    image.data[p] = value
    image.data[p + 1] = value
    image.data[p + 2] = value
    image.data[p + 3] = 255
  }

  ctx.putImageData(image, 0, 0)
  return output
}

/** Serialises a canvas for storage in the scene file. */
export const canvasToDataUrl = (canvas: HTMLCanvasElement): string => canvas.toDataURL('image/png')

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('تعذّر تحميل الصورة'))
    image.src = src
  })
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('تعذّر قراءة الملف'))
    reader.readAsDataURL(file)
  })
}
