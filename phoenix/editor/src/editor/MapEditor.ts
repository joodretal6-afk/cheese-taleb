import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PointerEventTypes,
  Scene,
  StandardMaterial,
  Vector3,
  type ArcRotateCameraPointersInput,
} from '@babylonjs/core'
import { createEmptyMap, type PhxMap } from '../map/phxmap'
import { Terrain, type BrushMode } from './Terrain'

export interface BrushState {
  mode: BrushMode
  radius: number
  strength: number
}

/**
 * The editor runtime: owns the Babylon engine, scene, camera and the terrain,
 * and turns left-button pointer strokes into sculpt operations. The React UI
 * drives it through a small imperative API.
 */
export class MapEditor {
  readonly engine: Engine
  readonly scene: Scene
  readonly camera: ArcRotateCamera
  terrain: Terrain

  readonly brush: BrushState = { mode: 'raise', radius: 60, strength: 2 }
  private map: PhxMap
  private painting = false
  private flattenTarget = 0
  private readonly cursor: Mesh

  /** Called with the world height under the cursor for the HUD. */
  onHover?: (info: { x: number; z: number; h: number } | null) => void

  constructor(canvas: HTMLCanvasElement, map?: PhxMap) {
    this.map = map ?? createEmptyMap()
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true }, true)
    this.scene = new Scene(this.engine)
    this.scene.clearColor = new Color4(0.53, 0.62, 0.74, 1)

    const world = this.map.meta.worldSizeMeters
    this.camera = new ArcRotateCamera('cam', -Math.PI / 2, 0.9, world * 0.9, Vector3.Zero(), this.scene)
    this.camera.attachControl(canvas, true)
    this.camera.wheelPrecision = 0.4
    this.camera.panningSensibility = 12
    this.camera.lowerRadiusLimit = 20
    this.camera.upperRadiusLimit = world * 2
    this.camera.maxZ = world * 4
    this.camera.upperBetaLimit = 1.52
    // Leave the LEFT button free for sculpting; orbit/pan on middle + right.
    const pointers = this.camera.inputs.attached.pointers as ArcRotateCameraPointersInput
    pointers.buttons = [1, 2]

    const sun = new DirectionalLight('sun', new Vector3(-0.5, -0.9, 0.4), this.scene)
    sun.intensity = 2.4
    const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), this.scene)
    sky.intensity = 0.55

    this.terrain = new Terrain(this.scene, this.map)

    // Brush cursor ring.
    this.cursor = MeshBuilder.CreateTorus('brushCursor', { diameter: 2, thickness: 0.06, tessellation: 48 }, this.scene)
    const cm = new StandardMaterial('brushCursorMat', this.scene)
    cm.emissiveColor = new Color3(1, 0.9, 0.2)
    cm.disableLighting = true
    this.cursor.material = cm
    this.cursor.isPickable = false
    this.cursor.renderingGroupId = 1

    this.installPointer()
    this.engine.runRenderLoop(() => this.scene.render())
    window.addEventListener('resize', this.onResize)
  }

  private onResize = () => this.engine.resize()

  private installPointer(): void {
    this.scene.onPointerObservable.add((pi) => {
      const ev = pi.event as PointerEvent
      if (pi.type === PointerEventTypes.POINTERDOWN && ev.button === 0) {
        const p = this.pick()
        if (p) {
          this.painting = true
          this.flattenTarget = this.terrain.heightAt(p.x, p.z)
          this.stroke(p.x, p.z)
        }
      } else if (pi.type === PointerEventTypes.POINTERUP && ev.button === 0) {
        this.painting = false
      } else if (pi.type === PointerEventTypes.POINTERMOVE) {
        const p = this.pick()
        if (p) {
          this.cursor.position.set(p.x, p.y + 0.5, p.z)
          const s = this.brush.radius
          this.cursor.scaling.set(s, s, s)
          this.onHover?.({ x: p.x, z: p.z, h: p.y })
          if (this.painting) this.stroke(p.x, p.z)
        } else {
          this.onHover?.(null)
        }
      }
    })
  }

  private pick(): { x: number; y: number; z: number } | null {
    const r = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => m === this.terrain.mesh)
    if (r?.hit && r.pickedPoint) return { x: r.pickedPoint.x, y: r.pickedPoint.y, z: r.pickedPoint.z }
    return null
  }

  private stroke(x: number, z: number): void {
    this.terrain.sculpt(x, z, this.brush.mode, this.brush.radius, this.brush.strength, this.flattenTarget)
  }

  // ---- imperative API for the UI ----

  setBrushMode(mode: BrushMode): void {
    this.brush.mode = mode
  }
  setRadius(r: number): void {
    this.brush.radius = r
  }
  setStrength(s: number): void {
    this.brush.strength = s
  }

  loadMap(map: PhxMap): void {
    this.terrain.dispose()
    this.map = map
    this.terrain = new Terrain(this.scene, map)
    this.camera.setTarget(Vector3.Zero())
    this.camera.radius = map.meta.worldSizeMeters * 0.9
  }

  newMap(): void {
    this.loadMap(createEmptyMap())
  }

  /** Snapshot the current state as a saveable map document. */
  getMap(): PhxMap {
    return { ...this.map, heights: this.terrain.exportHeights(), objects: this.map.objects }
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize)
    this.engine.dispose()
  }
}
