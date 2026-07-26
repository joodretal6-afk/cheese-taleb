import { useEffect, useRef, useState } from 'react'
import { PointerEventTypes } from '@babylonjs/core'
import { Panel } from '../Chrome'
import { PedestrianSystem } from '../../engine/pedestrian/PedestrianSystem'
import { EditorCamera } from '../../engine/EditorCamera'

// Reach the engine through this narrow hole; Babylon subfields stay `any` on
// purpose, like the other tool panels.
type SimLike = {
  scene: any
  field: any
  pedestrians?: PedestrianSystem
  editorCam?: EditorCamera
}

type StoreLike = {
  getState(): { settings: { running: boolean }; set(key: 'running', value: boolean): void }
}

function getSim(): SimLike | undefined {
  return (window as unknown as { sim?: SimLike }).sim
}

function getStore(): StoreLike | undefined {
  return (window as unknown as { __simStore?: StoreLike }).__simStore
}

/** The one pedestrian system, stashed on the sim so it survives panel unmounts. */
function getPeds(): PedestrianSystem | undefined {
  const sim = getSim()
  if (!sim) return undefined
  if (!sim.pedestrians) {
    sim.pedestrians = new PedestrianSystem(sim.scene, () => getSim()?.field)
  }
  return sim.pedestrians
}

/** The shared editor camera (same instance the traffic panel uses). */
function getEditorCam(): EditorCamera | undefined {
  const sim = getSim()
  if (!sim) return undefined
  if (!sim.editorCam) sim.editorCam = new EditorCamera(sim.scene)
  return sim.editorCam
}

export function PedestrianPanel() {
  const [drawing, setDrawing] = useState(false)
  const [activePts, setActivePts] = useState(0)
  const [paths, setPaths] = useState(0)
  const [count, setCount] = useState(() => getPeds()?.getCount() ?? 12)
  const [speed, setSpeed] = useState(() => getPeds()?.getSpeed() ?? 1.4)
  const [running, setRunning] = useState(false)
  const [walkers, setWalkers] = useState(0)
  const [editorCam, setEditorCam] = useState(false)
  const [camSpeed, setCamSpeed] = useState(() => getEditorCam()?.getSpeed() ?? 24)
  const [models, setModels] = useState<{ id: string; name: string; count: number; flip: boolean }[]>([])
  const [uploading, setUploading] = useState(false)

  const sysRef = useRef<PedestrianSystem | undefined>(undefined)
  sysRef.current = getPeds()
  const prevRunning = useRef<boolean | null>(null)

  function sync() {
    const t = sysRef.current
    if (!t) return
    setPaths(t.pathCount())
    setActivePts(t.activePointCount)
    setRunning(t.running)
    setWalkers(t.walkerCount())
    setDrawing(t.drawing)
    setModels(t.listModels())
  }

  useEffect(() => {
    if (!drawing) return
    const sim = getSim()
    const t = sysRef.current
    if (!sim || !t) return
    const scene = sim.scene
    const observer = scene.onPointerObservable.add((info: any) => {
      if (info.type !== PointerEventTypes.POINTERDOWN) return
      if ((info.event?.button ?? 0) !== 0) return
      const p = t.pickGround(scene.pointerX, scene.pointerY)
      if (!p) return
      t.addWaypoint(p.x, p.z)
      setActivePts(t.activePointCount)
    })
    return () => scene.onPointerObservable.remove(observer)
  }, [drawing])

  // --- Editor camera -----------------------------------------------------
  function enableEditorCam() {
    const cam = getEditorCam()
    if (!cam || cam.active) {
      setEditorCam(true)
      return
    }
    const store = getStore()
    if (store) {
      prevRunning.current = store.getState().settings.running
      store.getState().set('running', false)
    }
    cam.enable({ lookButton: 2 })
    setEditorCam(true)
  }

  function disableEditorCam() {
    getEditorCam()?.disable()
    const store = getStore()
    if (store && prevRunning.current !== null) {
      store.getState().set('running', prevRunning.current)
      prevRunning.current = null
    }
    setEditorCam(false)
  }

  function toggleEditorCam() {
    if (getEditorCam()?.active) disableEditorCam()
    else enableEditorCam()
  }

  function applyCamSpeed(v: number) {
    setCamSpeed(v)
    getEditorCam()?.setSpeed(v)
  }

  useEffect(() => {
    return () => {
      if (getEditorCam()?.active) disableEditorCam()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- Draw --------------------------------------------------------------
  function startDraw() {
    const t = sysRef.current
    if (!t) return
    t.beginPath()
    setDrawing(true)
    setActivePts(0)
    if (!getEditorCam()?.active) enableEditorCam()
  }

  function finishDraw() {
    const t = sysRef.current
    if (!t) return
    const ok = t.endPath()
    setDrawing(false)
    setActivePts(0)
    if (ok) {
      setWalkers(t.walkerCount())
      setPaths(t.pathCount())
    }
  }

  function cancelDraw() {
    sysRef.current?.cancelPath()
    setDrawing(false)
    setActivePts(0)
  }

  function clearAll() {
    const t = sysRef.current
    if (!t) return
    t.clearPaths()
    setRunning(false)
    setWalkers(0)
    setPaths(0)
  }

  function applyCount(v: number) {
    setCount(v)
    const t = sysRef.current
    if (!t) return
    t.setCount(v)
    setWalkers(t.walkerCount())
  }

  function applySpeed(v: number) {
    setSpeed(v)
    sysRef.current?.setSpeed(v)
  }

  function togglePlay() {
    const t = sysRef.current
    if (!t) return
    if (t.running) {
      t.pause()
      setRunning(false)
    } else {
      t.play()
      setRunning(t.running)
    }
  }

  // --- People library ----------------------------------------------------
  function refreshModels() {
    const t = sysRef.current
    if (!t) return
    setModels(t.listModels())
    setWalkers(t.walkerCount())
  }

  async function uploadModel(file: File | undefined) {
    const t = sysRef.current
    if (!file || !t) return
    setUploading(true)
    try {
      const url = URL.createObjectURL(file)
      const name = file.name.replace(/\.(glb|gltf)$/i, '')
      const ext = /\.gltf$/i.test(file.name) ? '.gltf' : '.glb'
      const id = await t.addModel(url, name, ext)
      if (id) refreshModels()
    } finally {
      setUploading(false)
    }
  }

  function applyModelCount(id: string, n: number) {
    sysRef.current?.setModelCount(id, n)
    refreshModels()
  }

  function toggleModelFlip(id: string, flip: boolean) {
    sysRef.current?.setModelFlip(id, flip)
    refreshModels()
  }

  function removeModel(id: string) {
    sysRef.current?.removeModel(id)
    refreshModels()
  }

  useEffect(() => {
    sync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const btn =
    'rounded-lg bg-ink-700 px-3 py-2 text-[12px] text-mist-200 transition-colors hover:bg-ink-600 disabled:opacity-40'
  const btnActive = 'rounded-lg bg-brand-500 px-3 py-2 text-[12px] text-white transition-colors hover:bg-brand-400'

  return (
    <Panel title="المشاة" className="min-w-0" bodyClassName="min-h-0 overflow-y-auto p-4">
      <div className="flex flex-col gap-4" dir="rtl">
        {/* Editor camera */}
        <div className="flex flex-col gap-2 rounded-lg border border-ink-700 bg-ink-900/40 p-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] font-medium text-mist-300">كاميرا المحرر</span>
            <button type="button" className={editorCam ? btnActive : btn} onClick={toggleEditorCam}>
              {editorCam ? 'مُفعّلة' : 'تفعيل'}
            </button>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-[12px] text-mist-400">سرعة الكاميرا</span>
            <input
              type="range"
              className="h-4 min-w-0 flex-1"
              min={4}
              max={120}
              step={1}
              value={camSpeed}
              aria-label="سرعة الكاميرا"
              onChange={(e) => applyCamSpeed(Number(e.target.value))}
            />
            <span className="w-10 shrink-0 text-end text-[12px] tabular-nums text-mist-300">{camSpeed}</span>
          </div>
          <p className="text-[11px] leading-4 text-mist-400">
            حركة <kbd className="rounded bg-ink-700 px-1 font-mono" dir="ltr">WASD</kbd> · ارتفاع
            <kbd className="mx-1 rounded bg-ink-700 px-1 font-mono" dir="ltr">E/Q</kbd> · نظر بالزر الأيمن ·
            رسم بالأيسر.
          </p>
        </div>

        {/* Draw a path */}
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-mist-300">مسارات المشي</span>
          {!drawing ? (
            <button type="button" className={btn} onClick={startDraw}>
              رسم مسار مشي جديد
            </button>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-brand-500/40 bg-brand-500/5 p-2.5">
              <p className="text-[11px] leading-4 text-mist-300">
                انقر على الأرض لإضافة نقاط المسار. يُغلق تلقائياً ليدور المشاة. النقاط:{' '}
                <span className="tabular-nums">{activePts}</span>
              </p>
              <div className="flex gap-2">
                <button type="button" className={btnActive} disabled={activePts < 2} onClick={finishDraw}>
                  إنهاء المسار
                </button>
                <button type="button" className={btn} onClick={cancelDraw}>
                  إلغاء
                </button>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between text-[11px] text-mist-400">
            <span>
              المسارات: <span className="tabular-nums text-mist-200">{paths}</span>
            </span>
            <button
              type="button"
              className="text-[11px] text-mist-400 underline-offset-2 hover:text-mist-200 hover:underline disabled:opacity-40"
              disabled={paths === 0 && !drawing}
              onClick={clearAll}
            >
              امسح كل المسارات
            </button>
          </div>
        </div>

        <div className="h-px bg-ink-700" />

        {/* Crowd size */}
        <div className="flex items-center gap-3">
          <span className="w-24 shrink-0 text-[12px] text-mist-400">مشاة افتراضيون</span>
          <input
            type="range"
            className="h-4 min-w-0 flex-1"
            min={0}
            max={80}
            step={1}
            value={count}
            aria-label="عدد المشاة الافتراضيين"
            onChange={(e) => applyCount(Number(e.target.value))}
          />
          <span className="w-10 shrink-0 text-end text-[12px] tabular-nums text-mist-300">{count}</span>
        </div>

        {/* People library */}
        <div className="flex flex-col gap-2 rounded-lg border border-ink-700 bg-ink-900/40 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-mist-300">
              مكتبة الشخصيات<span className="text-mist-500"> ({models.length}/50)</span>
            </span>
            <label
              className={`cursor-pointer rounded-lg px-3 py-1.5 text-[12px] transition-colors ${
                uploading ? 'bg-ink-700 text-mist-400' : 'bg-brand-500 text-white hover:bg-brand-400'
              }`}
            >
              {uploading ? '…جارٍ' : '+ ارفع شكل'}
              <input
                type="file"
                accept=".glb,.gltf,model/gltf-binary"
                className="hidden"
                disabled={uploading || models.length >= 50}
                onChange={(e) => void uploadModel(e.target.files?.[0])}
              />
            </label>
          </div>
          {models.length === 0 ? (
            <p className="text-[11px] leading-4 text-mist-400">
              ارفع ملف GLB لشخصية ليصير طرازاً — وحدد كم شخصاً من كل شكل.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {models.map((m) => (
                <div key={m.id} className="flex flex-col gap-1.5 rounded-md border border-ink-700 bg-ink-850 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12px] text-mist-200" title={m.name}>
                      {m.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeModel(m.id)}
                      className="shrink-0 text-[11px] text-mist-400 hover:text-red-400"
                    >
                      حذف
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-[11px] text-mist-400">العدد</span>
                    <input
                      type="range"
                      className="h-4 min-w-0 flex-1"
                      min={0}
                      max={40}
                      step={1}
                      value={m.count}
                      aria-label={`عدد ${m.name}`}
                      onChange={(e) => applyModelCount(m.id, Number(e.target.value))}
                    />
                    <span className="w-8 shrink-0 text-end text-[11px] tabular-nums text-mist-300">{m.count}</span>
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-[11px] text-mist-400">
                    <input type="checkbox" checked={m.flip} onChange={(e) => toggleModelFlip(m.id, e.target.checked)} />
                    اقلب الاتجاه (لو الشخصية تمشي للخلف)
                  </label>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Speed */}
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-[12px] text-mist-400">سرعة المشي</span>
          <input
            type="range"
            className="h-4 min-w-0 flex-1"
            min={0.3}
            max={4}
            step={0.1}
            value={speed}
            aria-label="سرعة المشي"
            onChange={(e) => applySpeed(Number(e.target.value))}
          />
          <span className="w-14 shrink-0 text-end text-[12px] tabular-nums text-mist-300">
            {speed.toFixed(1)} م/ث
          </span>
        </div>

        <div className="h-px bg-ink-700" />

        {/* Play / pause */}
        <div className="flex items-center gap-3">
          <button type="button" className={running ? btnActive : btn} disabled={paths === 0} onClick={togglePlay}>
            {running ? 'إيقاف المشي' : 'تشغيل المشي'}
          </button>
          <span className="text-[11px] text-mist-400">
            مشاة نشطون: <span className="tabular-nums text-mist-200">{walkers}</span>
          </span>
        </div>

        {paths === 0 && (
          <p className="text-[11px] leading-4 text-mist-400">ارسم مسار مشي واحداً على الأقل ثم شغّل.</p>
        )}
      </div>
    </Panel>
  )
}
