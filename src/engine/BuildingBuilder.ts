import {
  Color3,
  MeshBuilder,
  PBRMaterial,
  Texture,
  TransformNode,
  type Scene,
} from '@babylonjs/core'
import type { BuildingSpec } from './photo/buildingSpec'
import { generateFacadeImage } from './photo/facadeImage'

/**
 * Turn a BuildingSpec into a mesh.
 *
 * Four walls and a roof, each a plane carrying one texture that fills it: the
 * real de-lit photo where the user supplied one for that side, a drawn façade
 * where they did not. Windows and doors are not cut from geometry — they live
 * in the texture, which is exactly where they are in a real photo too, so the
 * front wall of a photographed building is that photograph, pixel for pixel.
 *
 * The whole thing is parented to one node, disabled, and handed to the brush as
 * a template to clone on click. It never touches physics — a placed building is
 * scenery you decorate with, not something the truck collides with (the region's
 * own buildings are the solid ones).
 */

export interface BuiltBuilding {
  node: TransformNode
  /** Longest horizontal side, so the brush can size it in metres. */
  longestM: number
}

export function buildBuilding(
  scene: Scene,
  spec: BuildingSpec,
  /** De-lit photo data URLs, indexed as the spec's photoIndex refers to them. */
  photos: (string | null)[],
): BuiltBuilding {
  const root = new TransformNode('aiBuilding', scene)
  const W = spec.widthM
  const D = spec.depthM
  const H = spec.floors * spec.floorHeightM

  // side → { size, position, rotationY, aspect }. Front faces -Z (toward the
  // camera when placed looking north), matching the engine's +Z-forward frame.
  const half = { w: W / 2, d: D / 2 }
  const faces: {
    side: BuildingSpec['sides'][number]['side']
    planeW: number
    px: number
    pz: number
    rotY: number
  }[] = [
    { side: 'front', planeW: W, px: 0, pz: -half.d, rotY: 0 },
    { side: 'back', planeW: W, px: 0, pz: half.d, rotY: Math.PI },
    { side: 'right', planeW: D, px: half.w, pz: 0, rotY: Math.PI / 2 },
    { side: 'left', planeW: D, px: -half.w, pz: 0, rotY: -Math.PI / 2 },
  ]

  for (const f of faces) {
    const sideSpec = spec.sides.find((s) => s.side === f.side)!
    const plane = MeshBuilder.CreatePlane(
      `aiWall_${f.side}`,
      // A plane's default normal is +Z; sourcePlane keeps UVs upright.
      { width: f.planeW, height: H, sideOrientation: 0 },
      scene,
    )
    plane.parent = root
    plane.position.set(f.px, H / 2, f.pz)
    plane.rotation.y = f.rotY

    const mat = new PBRMaterial(`aiWallMat_${f.side}`, scene)
    mat.metallic = 0
    mat.roughness = 0.88
    mat.backFaceCulling = true

    const photoUrl = sideSpec.photoIndex != null ? photos[sideSpec.photoIndex] ?? null : null
    const url =
      photoUrl ??
      generateFacadeImage(sideSpec, { size: 512, aspect: f.planeW / Math.max(0.5, H) })
    const tex = new Texture(url, scene)
    tex.uScale = 1
    tex.vScale = 1
    mat.albedoTexture = tex
    plane.material = mat
    plane.isPickable = false
  }

  // Roof. A flat slab for flat/parapet; parapet adds a low kerb wall so the
  // roofline reads from the street. Pitched gets two slabs meeting at a ridge.
  buildRoof(scene, root, spec, W, D, H)

  root.setEnabled(false)
  return { node: root, longestM: Math.max(W, D) }
}

function buildRoof(scene: Scene, root: TransformNode, spec: BuildingSpec, W: number, D: number, H: number) {
  const mat = new PBRMaterial('aiRoofMat', scene)
  mat.albedoColor = Color3.FromHexString(spec.roofColor)
  mat.metallic = 0
  mat.roughness = 0.92

  if (spec.roof === 'pitched') {
    const rise = Math.min(W, D) * 0.28
    for (const s of [-1, 1]) {
      const slope = MeshBuilder.CreatePlane(
        `aiRoofSlope_${s}`,
        { width: W, height: Math.hypot(D / 2, rise) },
        scene,
      )
      slope.parent = root
      slope.material = mat
      slope.isPickable = false
      slope.position.set(0, H + rise / 2, (s * D) / 4)
      slope.rotation.x = s * Math.atan2(rise, D / 2) - Math.PI / 2
    }
    return
  }

  const slab = MeshBuilder.CreatePlane('aiRoof', { width: W, height: D }, scene)
  slab.parent = root
  slab.material = mat
  slab.isPickable = false
  slab.position.set(0, H, 0)
  slab.rotation.x = Math.PI / 2

  if (spec.roof === 'parapet') {
    const kerbH = 0.9
    const kerbMat = new PBRMaterial('aiParapetMat', scene)
    kerbMat.albedoColor = Color3.FromHexString(spec.roofColor).scale(0.92)
    kerbMat.metallic = 0
    kerbMat.roughness = 0.9
    const kerbs: { w: number; x: number; z: number; ry: number }[] = [
      { w: W, x: 0, z: -D / 2, ry: 0 },
      { w: W, x: 0, z: D / 2, ry: Math.PI },
      { w: D, x: W / 2, z: 0, ry: Math.PI / 2 },
      { w: D, x: -W / 2, z: 0, ry: -Math.PI / 2 },
    ]
    for (const k of kerbs) {
      const wall = MeshBuilder.CreatePlane(`aiParapet_${k.x}_${k.z}`, { width: k.w, height: kerbH }, scene)
      wall.parent = root
      wall.material = kerbMat
      wall.isPickable = false
      wall.position.set(k.x, H + kerbH / 2, k.z)
      wall.rotation.y = k.ry
    }
  }
}
