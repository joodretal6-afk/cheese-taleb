import {
  Color3,
  ImportMeshAsync,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Quaternion,
  TransformNode,
  Texture,
  Vector3,
  type AbstractMesh,
  type Scene,
} from '@babylonjs/core'
import '@babylonjs/loaders/glTF'

/**
 * The brush.
 *
 * Two things it stamps onto the world where you click:
 *
 *   decal — any image, projected flat onto whatever surface is under the
 *           cursor. This is how a door photo lands on a wall, a window beside
 *           it, or a patch of grass on the ground: the picture conforms to the
 *           geometry it is painted on and clips to it, so a door on a wall stays
 *           on that wall.
 *
 *   model — a GLB dropped at the cursor, stood on the ground. Trees, barrels,
 *           a whole prop kit — placed by clicking, not by editing a file.
 *
 * Everything placed is remembered in order, so the last stroke can be taken
 * back and the whole lot cleared. A loaded model is imported once and cloned on
 * each click, so stamping fifty of the same tree costs one download.
 */

export type BrushMode = 'off' | 'decal' | 'model'

export interface BrushConfig {
  mode: BrushMode
  /** Data/blob/relative URL of the image (decal) or GLB (model). */
  url: string | null
  /** Decal: side length in metres. Model: target longest footprint in metres. */
  sizeM: number
  /** Spin about the surface normal (decal) or about +Y (model), degrees. */
  rotationDeg: number
}

interface Placed {
  root: AbstractMesh | TransformNode
  /** A decal's own material and texture, disposed with it. */
  material?: PBRMaterial
  texture?: Texture
}

/** How far a click may be from any surface before it counts as a miss. */
const PICK_PREDICATE_TAG = '__paintable__'

export class Painter {
  private readonly scene: Scene
  /** Meshes a click is allowed to land on: the ground and the buildings. */
  private targets: AbstractMesh[] = []
  private readonly placed: Placed[] = []
  private seq = 0

  private config: BrushConfig = { mode: 'off', url: null, sizeM: 2, rotationDeg: 0 }

  // A model brush loads its GLB once into a disabled template, then clones it.
  private modelUrl: string | null = null
  private modelTemplate: TransformNode | null = null
  private modelLongest = 1
  private modelLoading: Promise<void> | null = null

  /** Called after every successful stamp with the running count. */
  onChange?: (count: number) => void

  constructor(scene: Scene) {
    this.scene = scene
  }

  get active(): boolean {
    return this.config.mode !== 'off'
  }

  get count(): number {
    return this.placed.length
  }

  /** Meshes the brush is allowed to paint on. Set whenever the world rebuilds. */
  setTargets(meshes: (AbstractMesh | null | undefined)[]) {
    this.targets = meshes.filter((m): m is AbstractMesh => !!m)
    for (const m of this.targets) {
      m.metadata = { ...(m.metadata ?? {}), [PICK_PREDICATE_TAG]: true }
      // The terrain is normally unpickable (rays go to MudField, not the mesh),
      // so it has to be opted back in here or the brush would never hit ground.
      m.isPickable = true
    }
  }

  setConfig(config: Partial<BrushConfig>) {
    this.config = { ...this.config, ...config }
    // Preload a model as soon as it is chosen, so the first click is instant.
    if (this.config.mode === 'model' && this.config.url && this.config.url !== this.modelUrl) {
      void this.loadModel(this.config.url)
    }
  }

  getConfig(): BrushConfig {
    return { ...this.config }
  }

  /**
   * Arm the brush with an already-built node — an AI building, say — instead of
   * a GLB to download. It becomes the template cloned on each click.
   */
  armTemplateNode(node: TransformNode, longestM: number) {
    if (this.modelTemplate && this.modelTemplate !== node) this.modelTemplate.dispose()
    node.setEnabled(false)
    this.modelTemplate = node
    this.modelLongest = Math.max(0.01, longestM)
    this.modelUrl = `__node_${this.seq++}__`
    this.modelLoading = null
    // Place it at its real size by default — a 9 m building should land 9 m
    // wide, not shrunk to the brush's last decal size. The user can still resize
    // from the brush slider afterwards.
    this.config = { ...this.config, mode: 'model', url: this.modelUrl, sizeM: this.modelLongest }
  }

  // ------------------------------------------------------------------ stamping

  /**
   * Stamp at a screen position. Returns true if something was placed — false on
   * a miss (clicked the sky) or before an asset has been chosen, so the caller
   * can leave the camera alone only when a stamp actually happened.
   */
  async stampAtScreen(x: number, y: number): Promise<boolean> {
    if (!this.active || !this.config.url) return false

    const pick = this.scene.pick(x, y, (m) => !!m.metadata?.[PICK_PREDICATE_TAG])
    if (!pick?.hit || !pick.pickedPoint || !pick.pickedMesh) return false

    if (this.config.mode === 'decal') {
      this.stampDecal(pick.pickedMesh, pick.pickedPoint, pick.getNormal(true) ?? Vector3.Up())
      return true
    }
    if (this.config.mode === 'model') {
      return this.stampModel(pick.pickedPoint)
    }
    return false
  }

  private stampDecal(target: AbstractMesh, position: Vector3, normal: Vector3) {
    const s = Math.max(0.05, this.config.sizeM)
    const angle = (this.config.rotationDeg * Math.PI) / 180

    const decal = MeshBuilder.CreateDecal(`decal_${this.seq++}`, target, {
      position,
      normal,
      size: new Vector3(s, s, s),
      angle,
      // A little bias off the surface, so the projection wins the depth test
      // against the wall it sits on rather than z-fighting with it.
      localMode: false,
    })

    const mat = new PBRMaterial(`decalMat_${decal.name}`, this.scene)
    const tex = new Texture(this.config.url!, this.scene)
    // A cut-out image (a door on transparent background) must show its holes,
    // and a photo with no alpha simply fills its square — both handled by
    // reading alpha from the image and blending.
    tex.hasAlpha = true
    mat.albedoTexture = tex
    mat.useAlphaFromAlbedoTexture = true
    mat.transparencyMode = PBRMaterial.MATERIAL_ALPHABLEND
    mat.albedoColor = new Color3(1, 1, 1)
    mat.roughness = 0.9
    mat.metallic = 0
    mat.backFaceCulling = true
    mat.zOffset = -6
    decal.material = mat
    decal.isPickable = false
    // A repainted decal must not itself become a paint target.
    decal.metadata = {}

    this.placed.push({ root: decal, material: mat, texture: tex })
    this.onChange?.(this.placed.length)
  }

  private async stampModel(position: Vector3): Promise<boolean> {
    // Wait for the model to be ready: either it was never requested, or the
    // preload kicked off by setConfig is still in flight. Clicking before the
    // GLB finishes must place it once loaded, not silently do nothing.
    if (this.config.url !== this.modelUrl) await this.loadModel(this.config.url!)
    else if (this.modelLoading) await this.modelLoading
    if (!this.modelTemplate) return false

    const holder = new TransformNode(`model_${this.seq++}`, this.scene)
    const clone = this.modelTemplate.clone(`${holder.name}_geo`, holder)
    if (clone) clone.setEnabled(true)

    // Scale so the longest horizontal side matches the requested footprint.
    const scale = Math.max(0.02, this.config.sizeM) / this.modelLongest
    holder.scaling.setAll(scale)
    holder.rotationQuaternion = Quaternion.RotationAxis(
      Vector3.Up(),
      (this.config.rotationDeg * Math.PI) / 180,
    )
    holder.position.copyFrom(position)

    this.placed.push({ root: holder })
    this.onChange?.(this.placed.length)
    return true
  }

  // -------------------------------------------------------------------- models

  private loadModel(url: string): Promise<void> {
    if (url === this.modelUrl && this.modelTemplate) return Promise.resolve()
    if (this.modelLoading && url === this.modelUrl) return this.modelLoading

    this.modelUrl = url
    this.modelTemplate?.dispose()
    this.modelTemplate = null

    this.modelLoading = ImportMeshAsync(url, this.scene)
      .then((result) => {
        const meshes = result.meshes.filter(
          (m): m is Mesh => m instanceof Mesh && !!m.getTotalVertices(),
        )
        // Drop the loader's handedness-fix root into a template node of our own.
        const template = new TransformNode(`modelTemplate_${this.seq++}`, this.scene)
        for (const m of meshes) m.setParent(template)
        for (const m of result.meshes) if (m.name === '__root__') m.dispose()
        template.computeWorldMatrix(true)

        // Measure the footprint and re-seat the model so its base sits on y = 0
        // in template space; then a clone placed at a ground point stands on it.
        const min = new Vector3(Infinity, Infinity, Infinity)
        const max = new Vector3(-Infinity, -Infinity, -Infinity)
        for (const m of meshes) {
          m.computeWorldMatrix(true)
          const bb = m.getBoundingInfo().boundingBox
          min.minimizeInPlace(bb.minimumWorld)
          max.maximizeInPlace(bb.maximumWorld)
        }
        for (const m of meshes) {
          m.position.subtractInPlace(new Vector3((min.x + max.x) / 2, min.y, (min.z + max.z) / 2))
        }
        this.modelLongest = Math.max(0.01, Math.max(max.x - min.x, max.z - min.z))

        template.setEnabled(false)
        this.modelTemplate = template
      })
      .catch((err) => {
        console.error('[painter] could not load model', url, err)
        this.modelTemplate = null
      })
    return this.modelLoading
  }

  // --------------------------------------------------------------------- edits

  /** Remove the most recent stamp. Returns the new count. */
  undo(): number {
    const last = this.placed.pop()
    if (last) this.disposePlaced(last)
    this.onChange?.(this.placed.length)
    return this.placed.length
  }

  /** Remove everything painted. */
  clear() {
    for (const p of this.placed) this.disposePlaced(p)
    this.placed.length = 0
    this.onChange?.(0)
  }

  private disposePlaced(p: Placed) {
    p.texture?.dispose()
    p.material?.dispose()
    if (p.root instanceof TransformNode) {
      for (const c of p.root.getChildMeshes()) c.dispose()
    }
    p.root.dispose()
  }

  dispose() {
    this.clear()
    this.modelTemplate?.dispose()
    this.modelTemplate = null
  }
}
