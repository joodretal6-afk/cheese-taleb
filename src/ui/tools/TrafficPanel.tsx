import { useEffect, useRef, useState } from 'react'
import { PointerEventTypes } from '@babylonjs/core'
import { Panel } from '../Chrome'
import { TrafficSystem } from '../../engine/traffic/TrafficSystem'

// The engine appears on window only after boot; reach it through this narrow
// hole. Babylon subfields stay `any` on purpose — see the other tool panels.
type SimLike = {
  scene: any
  field: any
  traffic?: TrafficSystem
}

function getSim(): SimLike | undefined {
  return (window as unknown as { sim?: SimLike }).sim
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

export function TrafficPanel() {
  const [drawing, setDrawing] = useState(false)
  const [activePts, setActivePts] = useState(0)
  const [lanes, setLanes] = useState(0)
  const [count, setCount] = useState(() => getTraffic()?.getCount() ?? 8)
  const [speed, setSpeed] = useState(() => getTraffic()?.getSpeed() ?? 9)
  const [running, setRunning] = useState(false)
  const [cars, setCars] = useState(0)

  // Keep a live cursor into the traffic system without re-reading window each call.
  const sysRef = useRef<TrafficSystem | undefined>(undefined)
  sysRef.current = getTraffic()

  function sync() {
    const t = sysRef.current
    if (!t) return
    setLanes(t.laneCount())
    setActivePts(t.activePointCount)
    setRunning(t.running)
    setCars(t.carCount())
    setDrawing(t.drawing)
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
      const p = t.pickGround(scene.pointerX, scene.pointerY)
      if (!p) return
      t.addWaypoint(p.x, p.z)
      setActivePts(t.activePointCount)
    })
    return () => scene.onPointerObservable.remove(observer)
  }, [drawing])

  function startDraw() {
    const t = sysRef.current
    if (!t) return
    t.beginLane()
    setDrawing(true)
    setActivePts(0)
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

        {/* Fleet size ----------------------------------------------------- */}
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-[12px] text-mist-400">عدد السيارات</span>
          <input
            type="range"
            className="h-4 min-w-0 flex-1"
            min={0}
            max={60}
            step={1}
            value={count}
            aria-label="عدد السيارات"
            onChange={(e) => applyCount(Number(e.target.value))}
          />
          <span className="w-10 shrink-0 text-end text-[12px] tabular-nums text-mist-300">
            {count}
          </span>
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
