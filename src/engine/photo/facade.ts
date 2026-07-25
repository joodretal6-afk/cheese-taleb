import {
  Color3,
  Mesh,
  MultiMaterial,
  PBRMaterial,
  SubMesh,
  Texture,
  VertexData,
  type Scene,
} from '@babylonjs/core'
import { luma, type RGBAImage } from './types'

/**
 * Building from a facade photograph.
 *
 * A single photo carries no depth, so nothing here pretends to reconstruct one.
 * Instead we do what shipped games do for background architecture: take the
 * rectified, de-lit front elevation, extrude a simple volume behind it, and
 * project the photo onto the one face it is actually evidence for. The sides,
 * the back and the roof get a flat colour sampled from the facade itself — an
 * honest "we did not see this" rather than a smeared copy of the front wall.
 *
 * The result is cheap (12–16 triangles, two materials) and reads correctly from
 * the street, which is exactly where a background building is ever seen.
 */

export interface FacadeSpec {
  widthM: number
  heightM: number
  depthM: number
  /** Data URL of the rectified, de-lit facade albedo. */
  facadeUrl: string
  normalUrl?: string
  /** Colour used for the sides and back, sampled from the facade. */
  sideColor: Color3
  roof: 'flat' | 'pitched'
  roofPitchDeg: number
}

/**
 * Floor-to-floor height of a residential storey, metres. Building codes and
 * practice put this at 2.7–3.2 m almost everywhere (≈2.4 m clear ceiling plus
 * the floor structure), so 3 is the right single number to scale a photo by.
 */
const STOREY_HEIGHT_M = 3

/**
 * The walls continue this far below the origin plane. Callers drop the building
 * onto terrain by setting position.y to the ground height at one point, so on
 * any slope the downhill corners would otherwise float; a short skirt beds the
 * volume into the ground instead. It is not part of the photographed facade, so
 * it takes the side tint.
 */
const BASE_SKIRT_M = 0.4

/** Plausible facade proportions. Guards against a bad crop or a panorama. */
const MIN_ASPECT = 0.25
const MAX_ASPECT = 6
const MIN_WIDTH_M = 2.5
const MAX_WIDTH_M = 80

/** Pitched roofs below ~5° are built flat in practice, and above ~60° are spires. */
const MIN_PITCH_DEG = 5
const MAX_PITCH_DEG = 60

/** Border band sampled for the wall colour, as a fraction of the shorter edge. */
const EDGE_BAND_FRACTION = 0.03

/**
 * The bottom of a rectified facade almost always catches pavement, kerb or
 * planting, which would drag the wall colour grey. Skip it.
 */
const EDGE_BOTTOM_SKIP_FRACTION = 0.1

type V3 = [number, number, number]
type V2 = [number, number]

/** Material slots, in the order they are handed to the MultiMaterial. */
const SLOT_FACADE = 0
const SLOT_TINT = 1

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Round to centimetres — metre dimensions with float dust in them read badly in UI. */
function roundCm(v: number): number {
  return Math.round(v * 100) / 100
}

// ------------------------------------------------------------------ geometry

interface MeshBuild {
  positions: number[]
  normals: number[]
  uvs: number[]
  /** One index list per material slot, so each slot stays one contiguous SubMesh. */
  groups: [number[], number[]]
}

/**
 * Outward normal of a face whose corners run counter-clockwise *as seen from
 * outside*. The cross product is negated because Babylon is left-handed: its
 * front-facing test resolves to (p0-p1)x(p2-p1), the opposite sign of the
 * right-handed formula, and geometry wound the other way renders inside-out.
 */
function faceNormal(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0]
  const uy = b[1] - a[1]
  const uz = b[2] - a[2]
  const vx = c[0] - a[0]
  const vy = c[1] - a[1]
  const vz = c[2] - a[2]
  const nx = -(uy * vz - uz * vy)
  const ny = -(uz * vx - ux * vz)
  const nz = -(ux * vy - uy * vx)
  const len = Math.hypot(nx, ny, nz)
  // A degenerate face can only come from a zero dimension; point it up rather
  // than emitting NaNs that would poison the whole normal buffer.
  if (len < 1e-9) return [0, 1, 0]
  return [nx / len, ny / len, nz / len]
}

/** Append one flat convex face. Corners counter-clockwise seen from outside. */
function pushFace(b: MeshBuild, slot: 0 | 1, pts: V3[], uv: V2[]): void {
  const base = b.positions.length / 3
  const n = faceNormal(pts[0], pts[1], pts[2])
  for (let i = 0; i < pts.length; i++) {
    b.positions.push(pts[i][0], pts[i][1], pts[i][2])
    b.normals.push(n[0], n[1], n[2])
    b.uvs.push(uv[i][0], uv[i][1])
  }
  // Corners are never shared between faces: each one needs its own flat normal
  // and its own UV, and a facade box has too few vertices for welding to pay.
  const idx = b.groups[slot]
  for (let i = 2; i < pts.length; i++) idx.push(base, base + i - 1, base + i)
}

/**
 * Build the building volume.
 *
 * Origin sits at the base centre (x=0, y=0, z=0 is the middle of the ground
 * footprint), so a caller places it with `mesh.position.set(x, groundY, z)` the
 * same way every other prop in the engine is placed.
 *
 * The facade faces -Z. Rotate around Y to aim it at the street.
 */
export function buildFacadeMesh(scene: Scene, spec: FacadeSpec, name = 'facadeBuilding'): Mesh {
  const w = Math.max(0.5, spec.widthM)
  const h = Math.max(0.5, spec.heightM)
  const d = Math.max(0.5, spec.depthM)
  const hw = w / 2
  const hd = d / 2
  const skirt = BASE_SKIRT_M
  const pitched = spec.roof === 'pitched'
  const rise = pitched
    ? hd * Math.tan((clamp(spec.roofPitchDeg, MIN_PITCH_DEG, MAX_PITCH_DEG) * Math.PI) / 180)
    : 0

  const b: MeshBuild = { positions: [], normals: [], uvs: [], groups: [[], []] }

  // ---- front: the photograph, mapped 1:1 over the wall, nothing else ----
  // Pushed first so its vertices occupy a contiguous range at the head of the
  // buffers and its SubMesh can be given a tight vertex span.
  pushFace(
    b,
    SLOT_FACADE,
    [
      [-hw, 0, -hd],
      [hw, 0, -hd],
      [hw, h, -hd],
      [-hw, h, -hd],
    ],
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  )
  const facadeVertexCount = b.positions.length / 3
  const facadeIndexCount = b.groups[SLOT_FACADE].length

  // Everything below is tinted. UVs are in metres rather than 0..1 so that if a
  // caller later swaps in a tiling brick or render texture it lands at real
  // world scale instead of stretching one copy over each face.

  // front skirt
  pushFace(
    b,
    SLOT_TINT,
    [
      [-hw, -skirt, -hd],
      [hw, -skirt, -hd],
      [hw, 0, -hd],
      [-hw, 0, -hd],
    ],
    [
      [0, 0],
      [w, 0],
      [w, skirt],
      [0, skirt],
    ],
  )

  // back
  pushFace(
    b,
    SLOT_TINT,
    [
      [hw, -skirt, hd],
      [-hw, -skirt, hd],
      [-hw, h, hd],
      [hw, h, hd],
    ],
    [
      [0, 0],
      [w, 0],
      [w, h + skirt],
      [0, h + skirt],
    ],
  )

  // left (-X) and right (+X)
  pushFace(
    b,
    SLOT_TINT,
    [
      [-hw, -skirt, hd],
      [-hw, -skirt, -hd],
      [-hw, h, -hd],
      [-hw, h, hd],
    ],
    [
      [0, 0],
      [d, 0],
      [d, h + skirt],
      [0, h + skirt],
    ],
  )
  pushFace(
    b,
    SLOT_TINT,
    [
      [hw, -skirt, -hd],
      [hw, -skirt, hd],
      [hw, h, hd],
      [hw, h, -hd],
    ],
    [
      [0, 0],
      [d, 0],
      [d, h + skirt],
      [0, h + skirt],
    ],
  )

  // base cap — closed so the volume is watertight for the shadow map even when
  // a slope exposes the underside.
  pushFace(
    b,
    SLOT_TINT,
    [
      [-hw, -skirt, -hd],
      [-hw, -skirt, hd],
      [hw, -skirt, hd],
      [hw, -skirt, -hd],
    ],
    [
      [0, 0],
      [d, 0],
      [d, w],
      [0, w],
    ],
  )

  if (!pitched) {
    pushFace(
      b,
      SLOT_TINT,
      [
        [-hw, h, -hd],
        [hw, h, -hd],
        [hw, h, hd],
        [-hw, h, hd],
      ],
      [
        [0, 0],
        [w, 0],
        [w, d],
        [0, d],
      ],
    )
  } else {
    // Ridge runs along X, parallel to the facade, so the gables land on the two
    // tinted sides. A ridge the other way would put a gable triangle on the
    // front, and the rectified photo is a rectangle — it has no pixels for it.
    // Eaves are flush with the walls rather than overhanging: an overhang needs
    // a fascia and a soffit to stop reading as paper, which is more geometry
    // than a background building deserves.
    const slopeLen = Math.hypot(hd, rise)

    // front slope
    pushFace(
      b,
      SLOT_TINT,
      [
        [-hw, h, -hd],
        [hw, h, -hd],
        [hw, h + rise, 0],
        [-hw, h + rise, 0],
      ],
      [
        [0, 0],
        [w, 0],
        [w, slopeLen],
        [0, slopeLen],
      ],
    )
    // back slope
    pushFace(
      b,
      SLOT_TINT,
      [
        [hw, h, hd],
        [-hw, h, hd],
        [-hw, h + rise, 0],
        [hw, h + rise, 0],
      ],
      [
        [0, 0],
        [w, 0],
        [w, slopeLen],
        [0, slopeLen],
      ],
    )
    // gable triangles
    pushFace(
      b,
      SLOT_TINT,
      [
        [hw, h, -hd],
        [hw, h, hd],
        [hw, h + rise, 0],
      ],
      [
        [0, 0],
        [d, 0],
        [d / 2, rise],
      ],
    )
    pushFace(
      b,
      SLOT_TINT,
      [
        [-hw, h, hd],
        [-hw, h, -hd],
        [-hw, h + rise, 0],
      ],
      [
        [0, 0],
        [d, 0],
        [d / 2, rise],
      ],
    )
  }

  const mesh = new Mesh(name, scene)
  const data = new VertexData()
  data.positions = b.positions
  data.normals = b.normals
  data.uvs = b.uvs
  data.indices = [...b.groups[SLOT_FACADE], ...b.groups[SLOT_TINT]]
  data.applyToMesh(mesh, false)

  // Two sub-materials rather than one clever UV layout. The alternative —
  // parking the side UVs on a corner texel of the photo — still samples the
  // photo (so every side inherits whatever colour that texel happens to be),
  // and it forces one roughness and one normal map onto surfaces we have no
  // information about. One extra draw call per building buys a side material
  // that can be shared between buildings and tinted independently.
  const multi = new MultiMaterial(`${name}Mat`, scene)
  multi.subMaterials = [facadeMaterial(scene, spec, name), sideMaterial(scene, spec, name)]
  mesh.material = multi

  const totalVertices = b.positions.length / 3
  mesh.subMeshes = []
  new SubMesh(SLOT_FACADE, 0, facadeVertexCount, 0, facadeIndexCount, mesh)
  new SubMesh(
    SLOT_TINT,
    facadeVertexCount,
    totalVertices - facadeVertexCount,
    facadeIndexCount,
    b.groups[SLOT_TINT].length,
    mesh,
  )

  mesh.receiveShadows = true
  // Ground contact and vehicle collision are resolved analytically elsewhere in
  // the engine, so background buildings stay out of the picking pass.
  mesh.isPickable = false
  return mesh
}

function facadeMaterial(scene: Scene, spec: FacadeSpec, name: string): PBRMaterial {
  const mat = new PBRMaterial(`${name}FacadeMat`, scene)
  mat.metallic = 0
  // A de-lit facade is plaster, brick or stone; glazing is baked into the photo
  // and is not worth a second material at background distance.
  mat.roughness = 0.88

  const albedo = new Texture(spec.facadeUrl, scene, {
    noMipmap: false,
    samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
    gammaSpace: true,
  })
  albedo.name = `${name}Facade`
  // Clamped, never wrapped: the UVs are exactly 0..1 and any wrap would fold the
  // opposite edge of the photo into the wall at the seam.
  albedo.wrapU = Texture.CLAMP_ADDRESSMODE
  albedo.wrapV = Texture.CLAMP_ADDRESSMODE
  albedo.anisotropicFilteringLevel = 4
  mat.albedoTexture = albedo

  if (spec.normalUrl) {
    const bump = new Texture(spec.normalUrl, scene, {
      noMipmap: false,
      samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
      // Vector data, not colour — decoding it as sRGB would tilt every normal.
      gammaSpace: false,
    })
    bump.name = `${name}FacadeNormal`
    bump.wrapU = Texture.CLAMP_ADDRESSMODE
    bump.wrapV = Texture.CLAMP_ADDRESSMODE
    mat.bumpTexture = bump
  }
  return mat
}

function sideMaterial(scene: Scene, spec: FacadeSpec, name: string): PBRMaterial {
  const mat = new PBRMaterial(`${name}SideMat`, scene)
  // albedoColor feeds the shader as linear light, while the sampled colour comes
  // straight out of an sRGB photo; without the conversion the sides read washed
  // out next to the facade texture, which the pipeline does decode.
  mat.albedoColor = spec.sideColor.toLinearSpace()
  mat.metallic = 0
  mat.roughness = 0.95
  return mat
}

// ----------------------------------------------------------------- estimation

/**
 * Metric dimensions for a facade photo.
 *
 * The only reliable scale reference in a picture of a house is the storeys: a
 * residential floor-to-floor is about 3 m nearly everywhere (roughly 2.4 m of
 * clear height plus the floor structure), so height comes from the storey count
 * and width follows from the photo's aspect ratio.
 *
 * @param aspect  photo width / height, after rectification
 * @param storeys visible storeys, 1 or more
 */
export function estimateFacadeSize(aspect: number, storeys: number): { widthM: number; heightM: number } {
  const floors = Math.max(1, Math.round(Number.isFinite(storeys) ? storeys : 1))
  const heightM = floors * STOREY_HEIGHT_M
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const widthM = clamp(heightM * clamp(safeAspect, MIN_ASPECT, MAX_ASPECT), MIN_WIDTH_M, MAX_WIDTH_M)
  return { widthM: roundCm(widthM), heightM: roundCm(heightM) }
}

/**
 * Representative wall colour for the faces the photo never showed.
 *
 * Sampled from a band around the border, minus the bottom strip (pavement), and
 * trimmed to within one standard deviation of the mean brightness: a window or
 * a doorway touching the border is dark enough to pull a plain average several
 * shades below any real wall.
 */
export function averageEdgeColor(img: RGBAImage): Color3 {
  const { width: w, height: h, data } = img
  if (w < 1 || h < 1) return new Color3(0.5, 0.5, 0.5)

  const band = Math.max(1, Math.round(Math.min(w, h) * EDGE_BAND_FRACTION))
  const bottom = Math.max(0, h - Math.round(h * EDGE_BOTTOM_SKIP_FRACTION))
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  const ls: number[] = []

  const take = (x: number, y: number) => {
    const i = (y * w + x) * 4
    // Rectification leaves transparent margins outside the quad; they are not wall.
    if (data[i + 3] < 128) return
    rs.push(data[i])
    gs.push(data[i + 1])
    bs.push(data[i + 2])
    ls.push(luma(data[i], data[i + 1], data[i + 2]))
  }

  for (let y = 0; y < bottom; y++) {
    for (let x = 0; x < band && x < w; x++) {
      take(x, y)
      const mirrored = w - 1 - x
      if (mirrored > x) take(mirrored, y)
    }
  }
  for (let y = 0; y < band && y < bottom; y++) {
    for (let x = band; x < w - band; x++) take(x, y)
  }

  const n = ls.length
  if (n === 0) return new Color3(0.5, 0.5, 0.5)

  let sum = 0
  for (let i = 0; i < n; i++) sum += ls[i]
  const mean = sum / n
  let varSum = 0
  for (let i = 0; i < n; i++) varSum += (ls[i] - mean) * (ls[i] - mean)
  const sd = Math.sqrt(varSum / n)

  let r = 0
  let g = 0
  let bl = 0
  let kept = 0
  for (let i = 0; i < n; i++) {
    if (Math.abs(ls[i] - mean) > sd) continue
    r += rs[i]
    g += gs[i]
    bl += bs[i]
    kept++
  }
  // A facade that is genuinely two-tone can leave the trimmed set too small to
  // be representative; fall back to the plain mean rather than to noise.
  if (kept < n * 0.15) {
    r = 0
    g = 0
    bl = 0
    for (let i = 0; i < n; i++) {
      r += rs[i]
      g += gs[i]
      bl += bs[i]
    }
    kept = n
  }
  return new Color3(r / kept / 255, g / kept / 255, bl / kept / 255)
}
