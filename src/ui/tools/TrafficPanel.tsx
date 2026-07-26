import { useEffect, useRef, useState } from 'react'
import { PointerEventTypes } from '@babylonjs/core'
import { Panel } from '../Chrome'
import { TrafficSystem } from '../../engine/traffic/TrafficSystem'
import { EditorCamera } from '../../engine/EditorCamera'

// The engine appears on window only after boot; reach it through this narrow
// hole. Babylon subfields stay `any` on purpose — see the other tool panels.
type SimLike = {
  scene: any
  field: any
  traffic?: TrafficSystem
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

/**
 * Get the one traffic system, creating it on first use and stashing it on the
 * sim so it outlives this panel's mount/unmount — leaving the tools tab must
 * not wipe the cars you spawned.
 */
function getTraffic(): TrafficSystem | undefined {
  const sim = getSim()
  if (!sim) return undefined
  if (!sim.traffic) {
    sim.traffic = new TrafficSystem(sim.scene, () => getSim()?.field)
  }
  return sim.traffic
}

/** The one shared editor camera, likewise stashed on the sim. */
function getEditorCam(): EditorCamera | undefined {
  const sim = getSim()
  if (!sim) return undefined
  if (!sim.editorCam) sim.editorCam = new EditorCamera(sim.scene)
  return sim.editorCam
}

export function TrafficPanel() {
  const [drawing, setDrawing] = useState(false)
  const [activePts, setActivePts] = useState(0)
  const [lanes, setLanes] = useState(0)
  const [count, setCount] = useState(() => getTraffic()?.getCount() ?? 8)
  const [speed, setSpeed] = useState(() => getTraffic()?.getSpeed() ?? 9)
  const [running, setRunning] = useState(false)
  const [cars, setCars] = useState(0)
  const [editorCam, setEditorCam] = useState(false)
  const [camSpeed, setCamSpeed] = useState(() => getEditorCam()?.getSpeed() ?? 24)
  const [models, setModels] = useState<{ id: string; name: string; count: number; flip: boolean }[]>(
    [],
  )
  const [uploading, setUploading] = useState(false)

  // Keep a live cursor into the traffic system without re-reading window each call.
  const sysRef = useRef<TrafficSystem | undefined>(undefined)
  sysRef.current = getTraffic()
  // Remember the run state we paused when engaging the editor camera.
  const prevRunning = useRef<boolean | null>(null)

  function sync() {
    const t = sysRef.current
    if (!t) return
    setLanes(t.laneCount())
    setActivePts(t.activePointCount)
    setRunning(t.running)
    setCars(t.carCount())
    setDrawing(t.drawing)
    setModels(t.listModels())
  }

  // While drawing, each ground click drops a waypoint. Marching the field ray
  // rather than picking a mesh means it works no matter which tool owns picking.
  useEffect(() => {
    if (!drawing) return
    const sim = getSim()
    const t = sysRef.current
    if (!sim || !t) return
    const scene = sim.scene
    const observer = scene.onPointerObservable.add((info: any) => {
      if (info.type !== PointerEventTypes.POINTERDOWN) return
      // Left button only: the right button is the editor camera's look-drag.
      if ((info.event?.button ?? 0) !== 0) return
      const p = t.pickGround(scene.pointerX, scene.pointerY)
      if (!p) return
      t.addWaypoint(p.x, p.z)
      setActivePts(t.activePointCount)
    })
    return () => scene.onPointerObservable.remove(observer)
  }, [drawing])

  // --- Editor camera ------------------------------------------------------
  // Fly freely (right-drag to look, so left-click still draws), physics paused
  // while it's on so WASD doesn't also drive the truck.
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
    const cam = getEditorCam()
    cam?.disable()
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

  // Leaving the panel entirely shouldn't strand the camera in editor mode.
  useEffect(() => {
    return () => {
      if (getEditorCam()?.active) disableEditorCam()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function startDraw() {
    const t = sysRef.current
    if (!t) return
    t.beginLane()
    setDrawing(true)
    setActivePts(0)
    // Drawing wants a free view — bring the editor camera up automatically so
    // you can fly to any angle and keep left-clicking to place points.
    if (!getEditorCam()?.active) enableEditorCam()
  }

  function finishDraw() {
    const t = sysRef.current
    if (!t) return
    const ok = t.endLane()
    setDrawing(false)
    setActivePts(0)
    if (ok) {
      // A new lane means cars were rebuilt; reflect the fresh count.
      setCars(t.carCount())
      setLanes(t.laneCount())
    }
  }

  function cancelDraw() {
    const t = sysRef.current
    if (!t) return
    t.cancelLane()
    setDrawing(false)
    setActivePts(0)
  }

  function clearAll() {
    const t = sysRef.current
    if (!t) return
    t.clearLanes()
    setRunning(false)
    setCars(0)
    setLanes(0)
  }

  function applyCount(v: number) {
    setCount(v)
    const t = sysRef.current
    if (!t) return
    t.setCount(v)
    setCars(t.carCount())
  }

  function applySpeed(v: number) {
    setSpeed(v)
    sysRef.current?.setSpeed(v)
  }

  // --- Car library --------------------------------------------------------
  function refreshModels() {
    const t = sysRef.current
    if (!t) return
    setModels(t.listModels())
    setCars(t.carCount())
  }

  async function uploadModel(file: File | undefined) {
    const t = sysRef.current
    if (!file || !t) return
    setUploading(true)
    try {
      // A blob URL (not base64): a car GLB is megabytes and the loader reads a
      // URL directly. The blob carries no extension, so pass it explicitly or
      // Babylon can't pick the glTF loader.
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
    const t = sysRef.current
    if (!t) return
    t.setModelCount(id, n)
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

  // Reflect the current state when the panel first mounts.
  useEffect(() => {
    sync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const btn =
    'rounded-lg bg-ink-700 px-3 py-2 text-[12px] text-mist-200 transition-colors hover:bg-ink-600 disabled:opacity-40'
  const btnActive =
    'rounded-lg bg-brand-500 px-3 py-2 text-[12px] text-white transition-colors hover:bg-brand-400'

  return (
    <Panel title="المرور" className="min-w-0" bodyClassName="min-h-0 overflow-y-auto p-4">
      <div className="flex flex-col gap-4" dir="rtl">
        {/* Editor camera -------------------------------------------------- */}
        <div className="flex flex-col gap-2 rounded-lg border border-ink-700 bg-ink-900/40 p-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] font-medium text-mist-300">كاميرا المحرر</span>
            <button
              type="button"
              className={editorCam ? btnActive : btn}
              onClick={toggleEditorCam}
            >
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
            <span className="w-10 shrink-0 text-end text-[12px] tabular-nums text-mist-300">
              {camSpeed}
            </span>
          </div>
          <p className="text-[11px] leading-4 text-mist-400">
            حركة: <kbd className="rounded bg-ink-700 px-1 font-mono" dir="ltr">WASD</kbd> ·
            ارتفاع <kbd className="rounded bg-ink-700 px-1 font-mono" dir="ltr">E/Q</kbd> ·
            نظر بسحب <span className="text-mist-300">الزر الأيمن</span> ·
            رسم بالزر الأيسر · تسريع <kbd className="rounded bg-ink-700 px-1 font-mono" dir="ltr">Shift</kbd>.
          </p>
        </div>

        {/* Draw a path ---------------------------------------------------- */}
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-mist-300">مسارات السيارات</span>
          {!drawing ? (
            <button type="button" className={btn} onClick={startDraw}>
              رسم مسار جديد
            </button>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-brand-500/40 bg-brand-500/5 p-2.5">
              <p className="text-[11px] leading-4 text-mist-300">
                انقر على الأرض لإضافة نقاط المسار. المسار يُغلق تلقائياً لتدور
                السيارات بلا توقف. النقاط: <span className="tabular-nums">{activePts}</span>
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={btnActive}
                  disabled={activePts < 2}
                  onClick={finishDraw}
                >
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
              المسارات: <span className="tabular-nums text-mist-200">{lanes}</span>
            </span>
            <button
              type="button"
              className="text-[11px] text-mist-400 underline-offset-2 hover:text-mist-200 hover:underline disabled:opacity-40"
              disabled={lanes === 0 && !drawing}
              onClick={clearAll}
            >
              امسح كل المسارات
            </button>
          </div>
        </div>

        <div className="h-px bg-ink-700" />

        {/* Fleet size (generated cars) ------------------------------------ */}
        <div className="flex items-center gap-3">
          <span className="w-24 shrink-0 text-[12px] text-mist-400">سيارات افتراضية</span>
          <input
            type="range"
            className="h-4 min-w-0 flex-1"
            min={0}
            max={60}
            step={1}
            value={count}
            aria-label="عدد السيارات الافتراضية"
            onChange={(e) => applyCount(Number(e.target.value))}
          />
          <span className="w-10 shrink-0 text-end text-[12px] tabular-nums text-mist-300">
            {count}
          </span>
        </div>

        {/* Car library ---------------------------------------------------- */}
        <div className="flex flex-col gap-2 rounded-lg border border-ink-700 bg-ink-900/40 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-mist-300">
              مكتبة السيارات
              <span className="text-mist-500"> ({models.length}/50)</span>
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
              ارفع ملف GLB لسيارة ليصير طرازاً — وحدد كم سيارة من كل طراز تولّدها.
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
                      title="حذف الطراز"
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
                      max={30}
                      step={1}
                      value={m.count}
                      aria-label={`عدد ${m.name}`}
                      onChange={(e) => applyModelCount(m.id, Number(e.target.value))}
                    />
                    <span className="w-8 shrink-0 text-end text-[11px] tabular-nums text-mist-300">
                      {m.count}
                    </span>
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-[11px] text-mist-400">
                    <input
                      type="checkbox"
                      checked={m.flip}
                      onChange={(e) => toggleModelFlip(m.id, e.target.checked)}
                    />
                    اقلب الاتجاه (لو السيارة تسير للخلف)
                  </label>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Speed ---------------------------------------------------------- */}
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-[12px] text-mist-400">السرعة</span>
          <input
            type="range"
            className="h-4 min-w-0 flex-1"
            min={0}
            max={30}
            step={0.5}
            value={speed}
            aria-label="السرعة"
            onChange={(e) => applySpeed(Number(e.target.value))}
          />
          <span className="w-14 shrink-0 text-end text-[12px] tabular-nums text-mist-300">
            {Math.round(speed * 3.6)} كم/س
          </span>
        </div>

        <div className="h-px bg-ink-700" />

        {/* Play / pause --------------------------------------------------- */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            className={running ? btnActive : btn}
            disabled={lanes === 0}
            onClick={togglePlay}
          >
            {running ? 'إيقاف الحركة' : 'تشغيل الحركة'}
          </button>
          <span className="text-[11px] text-mist-400">
            سيارات نشطة: <span className="tabular-nums text-mist-200">{cars}</span>
          </span>
        </div>

        {lanes === 0 && (
          <p className="text-[11px] leading-4 text-mist-400">
            ارسم مساراً واحداً على الأقل ثم شغّل الحركة.
          </p>
        )}
      </div>
    </Panel>
  )
}
