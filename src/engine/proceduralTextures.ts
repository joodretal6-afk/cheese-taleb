import { RawTexture, Texture, type Scene } from '@babylonjs/core'
import { fbm, ridged, valueNoise2 } from './noise'

/**
 * Ground and mud maps are generated at runtime instead of shipped as image
 * files. Keeps the desktop build self-contained (no downloads, no licensing on
 * third-party texture packs) and lets the dashboard re-roll a material by
 * changing a seed.
 */

export interface GroundMapSet {
  albedo: RawTexture
  /** RGB = tangent-space normal, A = height (used for detail shading). */
  normalHeight: RawTexture
}

type Rgb = [number, number, number]

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

interface GroundSpec {
  /** Two base tones the noise blends between. */
  low: Rgb
  high: Rgb
  /** Speckle colour (pebbles/grit) and how often it shows. */
  speck: Rgb
  speckAmount: number
  /** Height relief strength for the derived normal map. */
  relief: number
  /** Noise frequency in texels. */
  grain: number
  /** Adds cracked/ridged structure — used by rock. */
  ridgedMix: number
  seed: number
}

const SPECS: Record<string, GroundSpec> = {
  dirt: {
    low: [0.29, 0.22, 0.155],
    high: [0.47, 0.375, 0.27],
    speck: [0.55, 0.5, 0.44],
    speckAmount: 0.16,
    relief: 1.0,
    grain: 9,
    ridgedMix: 0.12,
    seed: 11,
  },
  mud: {
    low: [0.085, 0.062, 0.042],
    high: [0.2, 0.145, 0.095],
    speck: [0.26, 0.21, 0.15],
    speckAmount: 0.08,
    relief: 1.35,
    grain: 6,
    ridgedMix: 0.3,
    seed: 23,
  },
  rock: {
    low: [0.2, 0.2, 0.205],
    high: [0.44, 0.435, 0.425],
    speck: [0.13, 0.13, 0.14],
    speckAmount: 0.2,
    relief: 1.8,
    grain: 5,
    ridgedMix: 0.75,
    seed: 37,
  },
  grass: {
    low: [0.13, 0.16, 0.075],
    high: [0.29, 0.33, 0.145],
    speck: [0.4, 0.38, 0.2],
    speckAmount: 0.22,
    relief: 0.8,
    grain: 16,
    ridgedMix: 0.05,
    seed: 53,
  },
}

/** Height field for one tile, wrapped so the texture tiles seamlessly. */
function buildHeight(size: number, spec: GroundSpec): Float32Array {
  const h = new Float32Array(size * size)
  const f = spec.grain / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Tile seamlessly by blending the field with its wrapped copies.
      const sample = (sx: number, sy: number) => {
        const a = fbm(sx * f, sy * f, 5, 2.03, 0.5, spec.seed)
        const r = ridged(sx * f * 1.7, sy * f * 1.7, 3, spec.seed + 5)
        return a * (1 - spec.ridgedMix) + r * spec.ridgedMix
      }
      const wx = x / size
      const wy = y / size
      const v =
        sample(x, y) * (1 - wx) * (1 - wy) +
        sample(x - size, y) * wx * (1 - wy) +
        sample(x, y - size) * (1 - wx) * wy +
        sample(x - size, y - size) * wx * wy
      h[y * size + x] = v
    }
  }
  return h
}

function makeGroundMaps(scene: Scene, name: string, spec: GroundSpec, size = 512): GroundMapSet {
  const height = buildHeight(size, spec)

  const albedoData = new Uint8Array(size * size * 4)
  const normalData = new Uint8Array(size * size * 4)

  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)]

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const hv = height[i]

      // --- albedo ---
      let c = mix(spec.low, spec.high, Math.min(1, Math.max(0, hv * 1.15 + 0.1)))
      // Grit speckle at a much higher frequency.
      const sp = valueNoise2(x * 0.55, y * 0.55, spec.seed + 91)
      if (sp > 1 - spec.speckAmount) {
        const t = (sp - (1 - spec.speckAmount)) / spec.speckAmount
        c = mix(c, spec.speck, t * 0.75)
      }
      // Broad blotches so large surfaces don't read as flat noise.
      const blotch = fbm(x * 0.006, y * 0.006, 3, 2.0, 0.5, spec.seed + 300)
      const bf = 0.82 + blotch * 0.36
      const o = i * 4
      albedoData[o] = Math.min(255, c[0] * bf * 255) | 0
      albedoData[o + 1] = Math.min(255, c[1] * bf * 255) | 0
      albedoData[o + 2] = Math.min(255, c[2] * bf * 255) | 0
      albedoData[o + 3] = 255

      // --- normal from height derivative (Sobel) ---
      const dx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
      const dy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
      const s = spec.relief * 3.2
      let nx = -dx * s
      let ny = -dy * s
      const nz = 1
      const inv = 1 / Math.hypot(nx, ny, nz)
      nx *= inv
      ny *= inv
      normalData[o] = ((nx * 0.5 + 0.5) * 255) | 0
      normalData[o + 1] = ((ny * 0.5 + 0.5) * 255) | 0
      normalData[o + 2] = ((nz * inv * 0.5 + 0.5) * 255) | 0
      normalData[o + 3] = (Math.min(1, Math.max(0, hv)) * 255) | 0
    }
  }

  const albedo = RawTexture.CreateRGBATexture(albedoData, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
  albedo.name = `${name}_albedo`
  albedo.wrapU = Texture.WRAP_ADDRESSMODE
  albedo.wrapV = Texture.WRAP_ADDRESSMODE

  const normalHeight = RawTexture.CreateRGBATexture(
    normalData, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE,
  )
  normalHeight.name = `${name}_nh`
  normalHeight.wrapU = Texture.WRAP_ADDRESSMODE
  normalHeight.wrapV = Texture.WRAP_ADDRESSMODE

  return { albedo, normalHeight }
}

export interface GroundLibrary {
  dirt: GroundMapSet
  mud: GroundMapSet
  rock: GroundMapSet
  grass: GroundMapSet
}

export function createGroundLibrary(scene: Scene, size = 512): GroundLibrary {
  return {
    dirt: makeGroundMaps(scene, 'dirt', SPECS.dirt, size),
    mud: makeGroundMaps(scene, 'mud', SPECS.mud, size),
    rock: makeGroundMaps(scene, 'rock', SPECS.rock, size),
    grass: makeGroundMaps(scene, 'grass', SPECS.grass, size),
  }
}

/**
 * Small preview swatches for the dashboard's material browser. Returned as data
 * URLs so the React side can render them as plain <img>.
 */
export function materialSwatch(kind: keyof typeof SPECS, variant: number, size = 96): string {
  const spec = { ...SPECS[kind], seed: SPECS[kind].seed + variant * 17 }
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)
  const f = spec.grain / size

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = fbm(x * f, y * f, 5, 2.03, 0.5, spec.seed)
      const r = ridged(x * f * 1.7, y * f * 1.7, 3, spec.seed + 5)
      const hv = a * (1 - spec.ridgedMix) + r * spec.ridgedMix
      let c = mix(spec.low, spec.high, Math.min(1, Math.max(0, hv * 1.15 + 0.1)))
      const sp = valueNoise2(x * 1.7, y * 1.7, spec.seed + 91)
      if (sp > 1 - spec.speckAmount) c = mix(c, spec.speck, 0.6)
      // Cheap directional shading so the swatch reads as a surface, not a blur.
      const hx = fbm((x + 1) * f, y * f, 5, 2.03, 0.5, spec.seed) - a
      const shade = 1 + hx * 6
      const o = (y * size + x) * 4
      img.data[o] = Math.max(0, Math.min(255, c[0] * shade * 255))
      img.data[o + 1] = Math.max(0, Math.min(255, c[1] * shade * 255))
      img.data[o + 2] = Math.max(0, Math.min(255, c[2] * shade * 255))
      img.data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}
