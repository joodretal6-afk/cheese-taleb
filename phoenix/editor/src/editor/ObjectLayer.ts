import {
  Color3,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Scene,
  Vector3,
} from '@babylonjs/core'
import type { ObjectKind, PlacedObject } from '../map/phxmap'

interface Proto {
  mesh: Mesh
  randomRot: boolean
  randomScale: number // +/- fraction of scale jitter (0 = none)
}

let idCounter = 0
function nextId(kind: ObjectKind): string {
  idCounter += 1
  return `${kind}_${idCounter}`
}

/**
 * Manages every placed object on the map (buildings, trees, rocks, spawn points,
 * loot spots, vehicle spawns). Each kind has a prototype mesh that placements
 * clone, so hundreds of objects share geometry and one material.
 */
export class ObjectLayer {
  private readonly scene: Scene
  private readonly protos = new Map<ObjectKind, Proto>()
  private readonly meshes = new Map<string, Mesh>()
  private objects: PlacedObject[] = []

  constructor(scene: Scene) {
    this.scene = scene
    this.buildProtos()
  }

  private mat(name: string, rgb: [number, number, number], emissive = false): StandardMaterial {
    const m = new StandardMaterial(`obj_${name}`, this.scene)
    const c = new Color3(...rgb)
    m.diffuseColor = c
    m.specularColor = new Color3(0.04, 0.04, 0.04)
    if (emissive) m.emissiveColor = c.scale(0.7)
    return m
  }

  private buildProtos(): void {
    // Building — a simple block.
    const building = MeshBuilder.CreateBox('proto_building', { width: 12, height: 9, depth: 12 }, this.scene)
    building.material = this.mat('building', [0.72, 0.68, 0.6])
    this.register('building', building, { randomRot: true, randomScale: 0.4 })

    // Tree — trunk + canopy merged.
    const trunk = MeshBuilder.CreateCylinder('t_trunk', { height: 3, diameterTop: 0.4, diameterBottom: 0.6 }, this.scene)
    trunk.position.y = 1.5
    const canopy = MeshBuilder.CreateCylinder('t_canopy', { height: 5, diameterTop: 0, diameterBottom: 4 }, this.scene)
    canopy.position.y = 5
    const tree = Mesh.MergeMeshes([trunk, canopy], true, true, undefined, false, false)!
    tree.name = 'proto_tree'
    tree.material = this.mat('tree', [0.11, 0.24, 0.12])
    this.register('tree', tree, { randomRot: true, randomScale: 0.35 })

    // Rock — lumpy sphere.
    const rock = MeshBuilder.CreateIcoSphere('proto_rock', { radius: 1.6, subdivisions: 2, flat: true }, this.scene)
    rock.material = this.mat('rock', [0.42, 0.42, 0.44])
    this.register('rock', rock, { randomRot: true, randomScale: 0.5 })

    // Spawn point — a bright green post + ring.
    const spawn = MeshBuilder.CreateCylinder('proto_spawn', { height: 6, diameter: 0.5 }, this.scene)
    spawn.position.y = 3
    spawn.material = this.mat('spawn', [0.2, 0.9, 0.35], true)
    this.register('spawn', spawn, { randomRot: false, randomScale: 0 })

    // Loot — a gold crate marker.
    const loot = MeshBuilder.CreateBox('proto_loot', { size: 2 }, this.scene)
    loot.position.y = 1
    loot.material = this.mat('loot', [0.95, 0.75, 0.15], true)
    this.register('loot', loot, { randomRot: true, randomScale: 0 })

    // Vehicle spawn — a blue pad.
    const vehicle = MeshBuilder.CreateBox('proto_vehicle', { width: 5, height: 0.4, depth: 2.4 }, this.scene)
    vehicle.position.y = 0.2
    vehicle.material = this.mat('vehicle', [0.2, 0.5, 0.95], true)
    this.register('vehicle', vehicle, { randomRot: true, randomScale: 0 })
  }

  private register(kind: ObjectKind, mesh: Mesh, opts: { randomRot: boolean; randomScale: number }): void {
    mesh.isPickable = false
    mesh.setEnabled(false) // prototypes never render directly
    this.protos.set(kind, { mesh, ...opts })
  }

  /** Place a new object of `kind` at world (x,z) sitting on ground height gy. */
  add(kind: ObjectKind, x: number, gy: number, z: number): PlacedObject {
    const proto = this.protos.get(kind)!
    const rot = proto.randomRot ? Math.random() * Math.PI * 2 : 0
    const scale = 1 + (proto.randomScale ? (Math.random() * 2 - 1) * proto.randomScale : 0)
    const obj: PlacedObject = { id: nextId(kind), kind, x, y: gy, z, rot, scale }
    this.objects.push(obj)
    this.spawnMesh(obj)
    return obj
  }

  private spawnMesh(obj: PlacedObject): void {
    const proto = this.protos.get(obj.kind)!
    const m = proto.mesh.clone(`obj_${obj.id}`)!
    m.setEnabled(true)
    m.isPickable = false
    m.position.set(obj.x, obj.y, obj.z)
    m.rotation.y = obj.rot
    m.scaling.setAll(obj.scale)
    this.meshes.set(obj.id, m)
  }

  /** Remove the object closest to (x,z) within `maxDist` metres. Returns true if one was removed. */
  removeNearest(x: number, z: number, maxDist = 30): boolean {
    let best: PlacedObject | null = null
    let bestD = maxDist * maxDist
    for (const o of this.objects) {
      const d = (o.x - x) ** 2 + (o.z - z) ** 2
      if (d < bestD) {
        bestD = d
        best = o
      }
    }
    if (!best) return false
    this.meshes.get(best.id)?.dispose()
    this.meshes.delete(best.id)
    this.objects = this.objects.filter((o) => o !== best)
    return true
  }

  /** Replace all objects (used when loading a map). heightAt resolves ground y. */
  loadFrom(objects: PlacedObject[], heightAt: (x: number, z: number) => number): void {
    for (const m of this.meshes.values()) m.dispose()
    this.meshes.clear()
    this.objects = []
    for (const o of objects) {
      const obj: PlacedObject = { ...o, y: heightAt(o.x, o.z) }
      this.objects.push(obj)
      this.spawnMesh(obj)
    }
  }

  getObjects(): PlacedObject[] {
    return this.objects.map((o) => ({ ...o }))
  }

  count(): number {
    return this.objects.length
  }

  /** Re-seat every object on the terrain after sculpting changed the ground. */
  reseat(heightAt: (x: number, z: number) => number): void {
    for (const o of this.objects) {
      o.y = heightAt(o.x, o.z)
      const m = this.meshes.get(o.id)
      if (m) m.position.y = o.y
    }
  }

  worldPoint(x: number, y: number, z: number): Vector3 {
    return new Vector3(x, y, z)
  }

  dispose(): void {
    for (const m of this.meshes.values()) m.dispose()
    this.meshes.clear()
    for (const p of this.protos.values()) p.mesh.dispose()
    this.protos.clear()
  }
}
