import { useEffect, useRef, useState } from 'react'
import {
  Color3,
  GizmoManager,
  HighlightLayer,
  PointerEventTypes,
  Vector3,
  type AbstractMesh,
  type Mesh,
  type Node,
  type Observer,
  type PointerInfo,
  type Scene,
  type TransformNode,
} from '@babylonjs/core'
import { Panel } from '../Chrome'

/**
 * أدوات الكائنات — Object tools.
 *
 * A live editor for painter-placed props. Everything the Painter stamps lands
 * in the scene as either a `decal_*` mesh (a flat projected image) or a
 * `model_*` TransformNode whose geometry is a `model_*_geo` clone underneath it.
 * This panel lets a developer pick one of those, move/rotate/scale it with
 * Babylon gizmos, snap it to the ground, duplicate, hide or delete it — none of
 * which the shipping brush exposes.
 *
 * The engine only appears on `window.sim` after boot, so every handler resolves
 * it lazily; nothing here assumes it exists at mount.
 */

// Only the fields this panel touches are typed — Babylon subtrees stay `any` to
// avoid dragging the full engine types through a dev tool.
type SimLike = {
  engine: unknown
  scene: Scene
  camera: { setTarget(v: Vector3): void }
  field: { surfaceHeight(x: number, z: number): number; worldSize: number }
  painter: unknown
  region?: unknown
  vehicle: unknown
  model: unknown
}

function getSim(): SimLike | undefined {
  return (window as unknown as { sim?: SimLike }).sim
}

type Selectable = AbstractMesh | TransformNode

interface Row {
  name: string
  kind: 'model' | 'decal'
}

/** A model holder is a top-level `model_*` node; its `_geo` clone is a child. */
function isModelHolder(n: { name: string; parent: Node | null }): boolean {
  return typeof n.name === 'string' && n.name.startsWith('model_') && !n.parent
}

/**
 * From whatever mesh the ray hit, resolve the thing the user meant to grab: a
 * decal is selected directly, a model is selected at its top-level holder (so
 * the gizmo drives the whole prop, not one sub-mesh).
 */
function resolveSelectable(hit: AbstractMesh): Selectable | null {
  if (hit.name.startsWith('decal_')) return hit
  let n: Node | null = hit
  let holder: TransformNode | null = null
  while (n) {
    if (isModelHolder(n as { name: string; parent: Node | null })) holder = n as TransformNode
    n = n.parent
  }
  return holder
}

export function ObjectToolsPanel() {
  const gizmoRef = useRef<GizmoManager | null>(null)
  const highlightRef = useRef<HighlightLayer | null>(null)
  const observerRef = useRef<Observer<PointerInfo> | null>(null)
  // The pointer callback is registered once; refs feed it the live state it
  // needs without re-subscribing on every selection.
  const selectModeRef = useRef(false)
  const selectedRef = useRef<Selectable | null>(null)

  const [selectMode, setSelectMode] = useState(false)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [gizmoKind, setGizmoKind] = useState<'move' | 'rotate' | 'scale' | null>(null)
  const [hidden, setHidden] = useState(false)
  const [rows, setRows] = useState<Row[]>([])

  // --- highlight ------------------------------------------------------------

  function paintHighlight(node: Selectable | null) {
    const hl = highlightRef.current
    if (!hl) return
    hl.removeAllMeshes()
    if (!node) return
    const color = Color3.FromHexString('#22d3a5')
    if ((node as AbstractMesh).getTotalVertices) {
      // A decal is itself a mesh.
      hl.addMesh(node as Mesh, color)
    }
    // A model holder has no geometry of its own — outline every child mesh.
    for (const child of node.getChildMeshes?.() ?? []) {
      if (child.getTotalVertices()) hl.addMesh(child as Mesh, color)
    }
  }

  // --- selection ------------------------------------------------------------

  function select(node: Selectable | null) {
    selectedRef.current = node
    paintHighlight(node)
    gizmoRef.current?.attachToNode(node ?? null)
    setSelectedName(node ? node.name : null)
    setHidden(node ? !node.isEnabled(false) : false)
  }

  // --- scene scan -----------------------------------------------------------

  function scan() {
    const sim = getSim()
    if (!sim) return
    const scene = sim.scene
    const found: Row[] = []
    for (const n of scene.transformNodes as TransformNode[]) {
      if (isModelHolder(n)) found.push({ name: n.name, kind: 'model' })
    }
    for (const m of scene.meshes as AbstractMesh[]) {
      if (m.name.startsWith('decal_')) found.push({ name: m.name, kind: 'decal' })
    }
    setRows(found)
  }

  function findByName(name: string): Selectable | null {
    const sim = getSim()
    if (!sim) return null
    return (
      (sim.scene.getTransformNodeByName(name) as TransformNode | null) ??
      (sim.scene.getMeshByName(name) as AbstractMesh | null)
    )
  }

  // --- lifecycle ------------------------------------------------------------

  useEffect(() => {
    const sim = getSim()
    if (!sim) return
    const scene = sim.scene

    const gizmo = new GizmoManager(scene)
    // We own selection through our own pointer handler; the manager must not
    // also grab whatever the pointer lands on.
    gizmo.usePointerToAttachGizmos = false
    gizmoRef.current = gizmo

    highlightRef.current = new HighlightLayer('objtools_hl', scene)

    observerRef.current = scene.onPointerObservable.add((pi: PointerInfo) => {
      if (!selectModeRef.current) return
      if (pi.type !== PointerEventTypes.POINTERPICK) return
      const pick = pi.pickInfo
      if (!pick?.hit || !pick.pickedMesh) return
      const node = resolveSelectable(pick.pickedMesh)
      if (node) select(node)
    })

    scan()
    // Objects come and go while the panel is open (brush stamps, undo); keep the
    // list roughly current without hammering the scene graph.
    const interval = window.setInterval(scan, 800)

    return () => {
      window.clearInterval(interval)
      if (observerRef.current) scene.onPointerObservable.remove(observerRef.current)
      observerRef.current = null
      highlightRef.current?.dispose()
      highlightRef.current = null
      gizmoRef.current?.dispose()
      gizmoRef.current = null
      selectedRef.current = null
    }
    // Boot-once: the effect wires the engine that is already present at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- actions --------------------------------------------------------------

  function toggleSelectMode() {
    const next = !selectMode
    selectModeRef.current = next
    setSelectMode(next)
  }

  function toggleGizmo(kind: 'move' | 'rotate' | 'scale') {
    const gizmo = gizmoRef.current
    if (!gizmo) return
    const next = gizmoKind === kind ? null : kind
    gizmo.positionGizmoEnabled = next === 'move'
    gizmo.rotationGizmoEnabled = next === 'rotate'
    gizmo.scaleGizmoEnabled = next === 'scale'
    // Re-attach so a freshly enabled gizmo binds to the current selection.
    gizmo.attachToNode(selectedRef.current ?? null)
    setGizmoKind(next)
  }

  function deleteSelected() {
    const node = selectedRef.current
    if (!node) return
    paintHighlight(null)
    gizmoRef.current?.attachToNode(null)
    // Recurse into children and free their materials/textures too.
    node.dispose(false, true)
    select(null)
    scan()
  }

  function duplicateSelected() {
    const node = selectedRef.current
    if (!node) return
    const isDecal = node.name.startsWith('decal_')
    const stamp = Date.now()
    const name = isDecal ? `decal_copy_${stamp}` : `model_copy_${stamp}`
    const clone = (node as unknown as {
      clone(name: string, parent: Node | null): Selectable | null
    }).clone(name, node.parent ?? null)
    if (!clone) return
    // Nudge the copy aside so it is visibly distinct from the original.
    const offset = new Vector3(2, 0, 2)
    clone.position = node.position.add(offset)
    scan()
    select(clone)
  }

  function groundSelected() {
    const sim = getSim()
    const node = selectedRef.current
    if (!sim || !node) return
    // The Painter reseats a model's base to y=0 in its local space, so the
    // holder's own y is the ground contact — set it straight from the field.
    const p = node.getAbsolutePosition()
    const y = sim.field.surfaceHeight(p.x, p.z)
    if (node.parent) {
      // Preserve x/z while lifting to the surface even under a parent frame.
      node.setAbsolutePosition(new Vector3(p.x, y, p.z))
    } else {
      node.position.y = y
    }
  }

  function toggleHidden() {
    const node = selectedRef.current
    if (!node) return
    const next = !node.isEnabled(false)
    node.setEnabled(next)
    setHidden(!next)
  }

  function focusRow(name: string) {
    const sim = getSim()
    const node = findByName(name)
    if (!sim || !node) return
    select(node)
    sim.camera.setTarget(node.getAbsolutePosition())
  }

  function deleteRow(name: string) {
    const node = findByName(name)
    if (!node) return
    if (selectedRef.current === node) {
      paintHighlight(null)
      gizmoRef.current?.attachToNode(null)
    }
    node.dispose(false, true)
    if (selectedRef.current === node) select(null)
    scan()
  }

  // --- render ---------------------------------------------------------------

  const hasSel = selectedName !== null
  const btn =
    'rounded-lg bg-ink-700 px-3 py-2 text-[12px] text-mist-200 transition-colors hover:bg-ink-600 disabled:opacity-40'
  const gizmoBtn = (kind: 'move' | 'rotate' | 'scale') =>
    `flex-1 rounded-lg px-3 py-2 text-[12px] transition-colors disabled:opacity-40 ${
      gizmoKind === kind
        ? 'bg-brand-500 text-white hover:bg-brand-400'
        : 'bg-ink-700 text-mist-200 hover:bg-ink-600'
    }`

  return (
    <Panel title="أدوات الكائنات" className="min-w-0" bodyClassName="min-h-0 overflow-y-auto p-4">
      <div className="flex h-full min-h-0 flex-col gap-3" dir="rtl">
        {/* Select mode */}
        <button
          type="button"
          onClick={toggleSelectMode}
          className={`rounded-lg px-3 py-2.5 text-[13px] font-medium transition-colors ${
            selectMode
              ? 'bg-brand-500 text-white hover:bg-brand-400'
              : 'bg-ink-700 text-mist-200 hover:bg-ink-600'
          }`}
        >
          {selectMode ? 'وضع التحديد: مُفعّل — انقر كائناً' : 'وضع التحديد'}
        </button>

        <div className="text-[11px] text-mist-400">
          {selectedName ? (
            <span dir="ltr" className="tabular-nums">
              {selectedName}
            </span>
          ) : (
            'لا يوجد تحديد'
          )}
        </div>

        {/* Gizmos */}
        <div>
          <div className="mb-1.5 text-[12px] text-mist-400">الأدوات</div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!hasSel}
              onClick={() => toggleGizmo('move')}
              className={gizmoBtn('move')}
            >
              تحريك
            </button>
            <button
              type="button"
              disabled={!hasSel}
              onClick={() => toggleGizmo('rotate')}
              className={gizmoBtn('rotate')}
            >
              تدوير
            </button>
            <button
              type="button"
              disabled={!hasSel}
              onClick={() => toggleGizmo('scale')}
              className={gizmoBtn('scale')}
            >
              تكبير
            </button>
          </div>
        </div>

        {/* Per-object actions */}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={!hasSel} onClick={groundSelected} className={btn}>
            على الأرض
          </button>
          <button type="button" disabled={!hasSel} onClick={toggleHidden} className={btn}>
            {hidden ? 'إظهار' : 'إخفاء'}
          </button>
          <button type="button" disabled={!hasSel} onClick={duplicateSelected} className={btn}>
            تكرار
          </button>
          <button
            type="button"
            disabled={!hasSel}
            onClick={deleteSelected}
            className="rounded-lg bg-ink-700 px-3 py-2 text-[12px] text-bad-500 transition-colors hover:bg-ink-600 disabled:opacity-40"
          >
            حذف
          </button>
        </div>

        {/* Object list */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[12px] text-mist-400">الكائنات الموضوعة</span>
            <span className="text-[11px] tabular-nums text-mist-400">{rows.length}</span>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {rows.length === 0 && (
              <div className="text-[11px] text-mist-400">لا كائنات — استخدم الفرشاة أولاً</div>
            )}
            {rows.map((r) => (
              <div
                key={r.name}
                className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${
                  r.name === selectedName ? 'border-brand-500 bg-ink-800' : 'border-ink-700'
                }`}
              >
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                    r.kind === 'model'
                      ? 'bg-brand-500/15 text-brand-400'
                      : 'bg-ink-700 text-mist-300'
                  }`}
                >
                  {r.kind === 'model' ? 'نموذج' : 'ملصق'}
                </span>
                <button
                  type="button"
                  onClick={() => focusRow(r.name)}
                  dir="ltr"
                  className="min-w-0 flex-1 truncate text-start text-[11px] text-mist-200 hover:text-mist-100"
                  title={r.name}
                >
                  {r.name}
                </button>
                <button
                  type="button"
                  onClick={() => deleteRow(r.name)}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-bad-500 hover:bg-ink-700"
                  aria-label="حذف"
                >
                  حذف
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  )
}
