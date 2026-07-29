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
import { createEmptyMap, type ObjectKind, type PhxMap } from '../map/phxmap'
import { ObjectLayer } from './ObjectLayer'
import { Terrain, type BrushMode } from './Terrain'

export type Tool = BrushMode | ObjectKind | 'erase' | 'gas'

const SCULPT_TOOLS: Tool[] = ['raise', 'lower', 'smooth', 'flatten']
const OBJECT_KINDS: ObjectKind[] = ['building', 'tree', 'rock', 'spawn', 'loot', 'vehicle']

export interface BrushState {
  radius: number
  strength: number
}

/**
 * The editor runtime: owns the Babylon engine, scene, camera, the terrain, the
 * object layer, the water plane and the gas-circle preview, and routes left-
 * button pointer input to the active tool.
 */
export class MapEditor {
  readonly engine: Engine
  readonly scene: Scene
  readonly camera: ArcRotateCamera
  terrain: Terrain
  objects: ObjectLayer

  tool: Tool = 'raise'
  readonly brush: BrushState = { radius: 60, strength: 2 }

  private map: PhxMap
  private painting = false
  private flattenTarget = 0
  private readonly cursor: Mesh
  private water: Mesh
  private gasRing: Mesh
  private gasCenter = { x: 0, z: 0 }
  private gasRadius = 700
  private waterLevel = -8

  onHover?: (info: { x: number; z: number; h: number } | null) => void
  onChange?: () => void

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
    const pointers = this.camera.inputs.attached.pointers as ArcRotateCameraPointersInput
    pointers.buttons = [1, 2] // left free for tools

    const sun = new DirectionalLight('sun', new Vector3(-0.5, -0.9, 0.4), this.scene)
    sun.intensity = 2.4
    const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), this.scene)
    sky.intensity = 0.55

    this.terrain = new Terrain(this.scene, this.map)
    this.objects = new ObjectLayer(this.scene)
    this.objects.loadFrom(this.map.objects, (x, z) => this.terrain.heightAt(x, z))

    // Water plane.
    this.water = this.buildWater(world)
    this.waterLevel = this.map.meta.water?.level ?? -8
    this.water.position.y = this.waterLevel

    // Gas circle.
    this.gasCenter = { x: this.map.meta.gas?.x ?? 0, z: this.map.meta.gas?.z ?? 0 }
    this.gasRadius = this.map.meta.gas?.radius ?? world * 0.35
    this.gasRing = this.buildGasRing()

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

  private buildWater(world: number): Mesh {
    const w = MeshBuilder.CreateGround('water', { width: world * 1.4, height: world * 1.4 }, this.scene)
    const m = new StandardMaterial('waterMat', this.scene)
    m.diffuseColor = new Color3(0.12, 0.28, 0.42)
    m.specularColor = new Color3(0.3, 0.35, 0.4)
    m.alpha = 0.62
    w.material = m
    w.isPickable = false
    return w
  }

  private buildGasRing(): Mesh {
    const ring = MeshBuilder.CreateTorus(
      'gasRing',
      { diameter: this.gasRadius * 2, thickness: 6, tessellation: 96 },
      this.scene,
    )
    const m = new StandardMaterial('gasMat', this.scene)
    m.emissiveColor = new Color3(0.35, 0.85, 1)
    m.disableLighting = true
    m.alpha = 0.85
    ring.material = m
    ring.isPickable = false
    ring.renderingGroupId = 1
    ring.position.set(this.gasCenter.x, this.terrain.heightAt(this.gasCenter.x, this.gasCenter.z) + 3, this.gasCenter.z)
    return ring
  }

  private rebuildGasRing(): void {
    this.gasRing.dispose()
    this.gasRing = this.buildGasRing()
  }

  private installPointer(): void {
    this.scene.onPointerObservable.add((pi) => {
      const ev = pi.event as PointerEvent
      const p = this.pick()
      if (pi.type === PointerEventTypes.POINTERDOWN && ev.button === 0 && p) {
        this.applyToolDown(p.x, p.z)
      } else if (pi.type === PointerEventTypes.POINTERUP && ev.button === 0) {
        if (this.painting) {
          this.painting = false
          this.objects.reseat((x, z) => this.terrain.heightAt(x, z))
        }
      } else if (pi.type === PointerEventTypes.POINTERMOVE) {
        if (p) {
          this.updateCursor(p.x, p.y, p.z)
          this.onHover?.({ x: p.x, z: p.z, h: p.y })
          if (this.painting) this.terrain.sculpt(p.x, p.z, this.tool as BrushMode, this.brush.radius, this.brush.strength, this.flattenTarget)
        } else {
          this.onHover?.(null)
        }
      }
    })
  }

  private applyToolDown(x: number, z: number): void {
    if (SCULPT_TOOLS.includes(this.tool)) {
      this.painting = true
      this.flattenTarget = this.terrain.heightAt(x, z)
      this.terrain.sculpt(x, z, this.tool as BrushMode, this.brush.radius, this.brush.strength, this.flattenTarget)
    } else if (OBJECT_KINDS.includes(this.tool as ObjectKind)) {
      this.objects.add(this.tool as ObjectKind, x, this.terrain.heightAt(x, z), z)
      this.onChange?.()
    } else if (this.tool === 'erase') {
      if (this.objects.removeNearest(x, z)) this.onChange?.()
    } else if (this.tool === 'gas') {
      this.gasCenter = { x, z }
      this.rebuildGasRing()
      this.onChange?.()
    }
  }

  private updateCursor(x: number, y: number, z: number): void {
    const sculpt = SCULPT_TOOLS.includes(this.tool)
    this.cursor.setEnabled(sculpt)
    if (sculpt) {
      this.cursor.position.set(x, y + 0.5, z)
      this.cursor.scaling.setAll(this.brush.radius)
    }
  }

  private pick(): { x: number; y: number; z: number } | null {
    const r = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => m === this.terrain.mesh)
    if (r?.hit && r.pickedPoint) return { x: r.pickedPoint.x, y: r.pickedPoint.y, z: r.pickedPoint.z }
    return null
  }

  // ---- imperative API for the UI ----

  setTool(tool: Tool): void {
    this.tool = tool
  }
  setRadius(r: number): void {
    this.brush.radius = r
  }
  setStrength(s: number): void {
    this.brush.strength = s
  }
  setWaterLevel(level: number): void {
    this.waterLevel = level
    this.water.position.y = level
  }
  getWaterLevel(): number {
    return this.waterLevel
  }
  setGasRadius(r: number): void {
    this.gasRadius = r
    this.rebuildGasRing()
  }
  getGasRadius(): number {
    return this.gasRadius
  }

  loadMap(map: PhxMap): void {
    this.terrain.dispose()
    this.map = map
    this.terrain = new Terrain(this.scene, map)
    this.objects.loadFrom(map.objects, (x, z) => this.terrain.heightAt(x, z))
    this.setWaterLevel(map.meta.water?.level ?? -8)
    this.gasCenter = { x: map.meta.gas?.x ?? 0, z: map.meta.gas?.z ?? 0 }
    this.gasRadius = map.meta.gas?.radius ?? map.meta.worldSizeMeters * 0.35
    this.rebuildGasRing()
    this.camera.setTarget(Vector3.Zero())
    this.camera.radius = map.meta.worldSizeMeters * 0.9
    this.onChange?.()
  }

  newMap(): void {
    this.objects.loadFrom([], () => 0)
    this.loadMap(createEmptyMap())
  }

  /** Snapshot the current state as a saveable map document. */
  getMap(): PhxMap {
    return {
      meta: {
        ...this.map.meta,
        water: { level: this.waterLevel },
        gas: { x: this.gasCenter.x, z: this.gasCenter.z, radius: this.gasRadius },
      },
      heights: this.terrain.exportHeights(),
      objects: this.objects.getObjects(),
    }
  }

  objectCount(): number {
    return this.objects.count()
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize)
    this.objects.dispose()
    this.engine.dispose()
  }
}
