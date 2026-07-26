import { useEffect, useRef, useState } from 'react'
import { MeshBuilder, Color3, Vector3, PointerEventTypes } from '@babylonjs/core'
import { Panel } from '../Chrome'
import { KhalidiyaRoad } from '../../engine/scene/KhalidiyaRoad'

// The engine appears on window only after boot, so it is always accessed
// through this narrow typed hole rather than assumed at module load. Babylon
// subfields stay `any` on purpose — importing their exact types here would drag
// half the engine into a dev-tools panel for no benefit.
type SimLike = {
  engine: any
  scene: any
  camera: any
  field: any
  painter: any
  region?: any
  vehicle: any
  model: any
  terrain: any
  khalidiyaRoad?: KhalidiyaRoad
}

type SimStoreLike = {
  getState(): { set(key: string, value: unknown): void; settings: { timeOfDay: number } }
}

function getSim(): SimLike | undefined {
  return (window as unknown as { sim?: SimLike }).sim
}

function getStore(): SimStoreLike | undefined {
  return (window as unknown as { __simStore?: SimStoreLike }).__simStore
}

// EXP2 fog mode constant. Hard-coded to avoid importing the Scene class purely
// for a static — Babylon's Scene.FOGMODE_EXP2 is this value.
const FOGMODE_EXP2 = 3

/** Two-digit HH:MM clock from an hours-with-fraction value. */
function formatClock(t: number): string {
  const hh = Math.floor(t)
  const mm = Math.round((t - hh) * 60)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export function WorldToolsPanel() {
  // --- Time of day -------------------------------------------------------
  // Mirror of the store value so the slider stays smooth even while the
  // day/night cycle is driving the same store key underneath us.
  const [timeOfDay, setTimeOfDay] = useState(
    () => getStore()?.getState().settings.timeOfDay ?? 12,
  )

  function applyTime(v: number) {
    setTimeOfDay(v)
    getStore()?.getState().set('timeOfDay', v)
  }

  // --- Day / night cycle -------------------------------------------------
  const [cycleOn, setCycleOn] = useState(false)
  const [cycleSpeed, setCycleSpeed] = useState(1) // hours advanced per second
  const cycleSpeedRef = useRef(cycleSpeed)
  cycleSpeedRef.current = cycleSpeed

  useEffect(() => {
    if (!cycleOn) return
    const stepMs = 100 // 10 Hz — smooth enough without hammering the store
    const id = window.setInterval(() => {
      const store = getStore()
      if (!store) return
      const cur = store.getState().settings.timeOfDay
      // Advance by speed (hours/sec) scaled to the tick, wrapping at 24.
      const next = (cur + cycleSpeedRef.current * (stepMs / 1000)) % 24
      store.getState().set('timeOfDay', next)
      setTimeOfDay(next)
    }, stepMs)
    return () => window.clearInterval(id)
  }, [cycleOn])

  // --- Fog ---------------------------------------------------------------
  const [fog, setFog] = useState(0)
  // Remember what fog looked like before we touched it, so density 0 restores
  // the scene's original mode instead of forcing EXP2 forever.
  const prevFog = useRef<{ mode: number; density: number } | null>(null)

  function applyFog(v: number) {
    setFog(v)
    const sim = getSim()
    if (!sim) return
    const scene = sim.scene
    if (prevFog.current === null) {
      prevFog.current = { mode: scene.fogMode, density: scene.fogDensity }
    }
    if (v <= 0) {
      // Restore the scene's own fog settings.
      const p = prevFog.current
      scene.fogMode = p.mode
      scene.fogDensity = p.density
      prevFog.current = null
      return
    }
    if (scene.fogMode !== FOGMODE_EXP2) scene.fogMode = FOGMODE_EXP2
    scene.fogDensity = v
  }

  // Restore fog on unmount if we left it engaged.
  useEffect(() => {
    return () => {
      const p = prevFog.current
      if (!p) return
      const sim = getSim()
      if (sim) {
        sim.scene.fogMode = p.mode
        sim.scene.fogDensity = p.density
      }
      prevFog.current = null
    }
  }, [])

  // --- Measure tool ------------------------------------------------------
  const [measuring, setMeasuring] = useState(false)
  const [distance, setDistance] = useState<number | null>(null)
  const measurePts = useRef<Vector3[]>([])
  const measureLine = useRef<any>(null)

  function clearMeasureLine() {
    if (measureLine.current) {
      measureLine.current.dispose()
      measureLine.current = null
    }
  }

  function resetMeasure() {
    clearMeasureLine()
    measurePts.current = []
    setDistance(null)
  }

  useEffect(() => {
    if (!measuring) return
    const sim = getSim()
    if (!sim) return
    const scene = sim.scene

    // On each ground click, record the point; on the second, draw the segment
    // and report its length. A third click starts a fresh measurement.
    const observer = scene.onPointerObservable.add((info: any) => {
      if (info.type !== PointerEventTypes.POINTERDOWN) return
      const pick = scene.pick(scene.pointerX, scene.pointerY, (m: any) => !!m.isPickable)
      const point: Vector3 | null = pick?.pickedPoint ?? null
      if (!point) return

      if (measurePts.current.length >= 2) {
        resetMeasure()
      }
      measurePts.current.push(point.clone())

      if (measurePts.current.length === 2) {
        const [a, b] = measurePts.current
        clearMeasureLine()
        const line = MeshBuilder.CreateLines(
          'devtool_measure',
          { points: [a, b] },
          scene,
        )
        line.color = new Color3(1, 0.85, 0.2)
        line.isPickable = false
        measureLine.current = line
        setDistance(Vector3.Distance(a, b))
      }
    })

    return () => {
      scene.onPointerObservable.remove(observer)
    }
  }, [measuring])

  // Drop any drawn segment when the tool unmounts entirely.
  useEffect(() => {
    return () => clearMeasureLine()
  }, [])

  // --- Reference grid ----------------------------------------------------
  const [gridOn, setGridOn] = useState(false)
  const [spacing, setSpacing] = useState(10)
  const gridMesh = useRef<any>(null)

  function disposeGrid() {
    if (gridMesh.current) {
      gridMesh.current.dispose()
      gridMesh.current = null
    }
  }

  useEffect(() => {
    if (!gridOn) return
    const sim = getSim()
    if (!sim) return
    const scene = sim.scene
    const size: number = sim.field.worldSize ?? 100
    const half = size / 2
    const step = Math.max(1, spacing)

    // Build the grid as a LineSystem, sampling terrain height along each line so
    // it drapes over the mud instead of floating on a flat plane.
    const lines: Vector3[][] = []
    const yLift = 0.05 // tiny lift to avoid z-fighting with the ground
    const sample = (x: number, z: number) =>
      new Vector3(x, (sim.field.surfaceHeight?.(x, z) ?? 0) + yLift, z)

    for (let x = -half; x <= half + 1e-3; x += step) {
      const line: Vector3[] = []
      for (let z = -half; z <= half + 1e-3; z += step) line.push(sample(x, z))
      lines.push(line)
    }
    for (let z = -half; z <= half + 1e-3; z += step) {
      const line: Vector3[] = []
      for (let x = -half; x <= half + 1e-3; x += step) line.push(sample(x, z))
      lines.push(line)
    }

    disposeGrid()
    const grid = MeshBuilder.CreateLineSystem('devtool_grid', { lines }, scene)
    grid.color = new Color3(0.35, 0.55, 0.7)
    grid.alpha = 0.5
    grid.isPickable = false
    gridMesh.current = grid

    return () => disposeGrid()
  }, [gridOn, spacing])

  // --- Compass -----------------------------------------------------------
  const [heading, setHeading] = useState(0) // degrees, 0 = north (+Z)
  useEffect(() => {
    const id = window.setInterval(() => {
      const sim = getSim()
      if (!sim) return
      const cam = sim.camera
      let yaw: number
      const ray = cam.getForwardRay?.()
      if (ray) {
        // Heading from the forward direction on the XZ plane.
        yaw = Math.atan2(ray.direction.x, ray.direction.z)
      } else {
        yaw = cam.rotation?.y ?? 0
      }
      setHeading(((yaw * 180) / Math.PI) % 360)
    }, 100)
    return () => window.clearInterval(id)
  }, [])

  // --- Shortcuts help ----------------------------------------------------
  const [showHelp, setShowHelp] = useState(false)
  const shortcuts: { key: string; desc: string }[] = [
    { key: 'WASD', desc: 'قيادة / مشي' },
    { key: 'Space', desc: 'مكابح / قفز' },
    { key: 'Shift', desc: 'جري' },
    { key: 'F', desc: 'ركوب / نزول' },
    { key: 'R', desc: 'إعادة' },
  ]

  const btn =
    'rounded-lg bg-ink-700 px-3 py-2 text-[12px] text-mist-200 transition-colors hover:bg-ink-600'
  const btnActive = 'rounded-lg bg-brand-500 px-3 py-2 text-[12px] text-white transition-colors hover:bg-brand-400'

  // --- Khalidiya road scene ----------------------------------------------
  const [roadOn, setRoadOn] = useState(false)
  function toggleRoad() {
    const sim = getSim()
    if (!sim) return
    if (!sim.khalidiyaRoad) sim.khalidiyaRoad = new KhalidiyaRoad(sim as never)
    if (sim.khalidiyaRoad.built) {
      sim.khalidiyaRoad.clear()
      setRoadOn(false)
    } else {
      sim.khalidiyaRoad.build()
      setRoadOn(true)
    }
  }

  return (
    <Panel title="العالم" className="min-w-0" bodyClassName="min-h-0 overflow-y-auto p-4">
      <div className="flex flex-col gap-4" dir="rtl">
        {/* Khalidiya road scene */}
        <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
          <span className="text-[12px] font-medium text-amber-300">مشهد شارع الخالدية</span>
          <p className="text-[11px] leading-4 text-mist-400">
            شارع مزدوج بأسفلت وخطوط، جزيرة وسطية على طوله، حواجز حديدية، أرض صحراوية
            رملية، وبيوت بلون البلد.
          </p>
          <button
            type="button"
            className={roadOn ? btnActive : btn}
            onClick={toggleRoad}
          >
            {roadOn ? 'إزالة المشهد' : 'ابنِ مشهد الخالدية'}
          </button>
        </div>

        <div className="h-px bg-ink-700" />

        {/* Time of day */}
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-[12px] text-mist-400">الوقت</span>
          <input
            type="range"
            className="h-4 min-w-0 flex-1"
            min={0}
            max={24}
            step={0.05}
            value={timeOfDay}
            aria-label="الوقت"
            onChange={(e) => applyTime(Number(e.target.value))}
          />
          <span className="w-12 shrink-0 text-end text-[12px] tabular-nums text-mist-300">
            {formatClock(timeOfDay)}
          </span>
        </div>

        {/* Day/night cycle */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <button
              type="button"
              className={cycleOn ? btnActive : btn}
              onClick={() => setCycleOn((v) => !v)}
            >
              {cycleOn ? 'إيقاف الدورة' : 'دورة ليل/نهار'}
            </button>
            <span className="text-[11px] text-mist-400">
              {cycleOn ? `×${cycleSpeed.toFixed(1)}` : ''}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-[12px] text-mist-400">سرعة الدورة</span>
            <input
              type="range"
              className="h-4 min-w-0 flex-1"
              min={0.1}
              max={6}
              step={0.1}
              value={cycleSpeed}
              aria-label="سرعة الدورة"
              onChange={(e) => setCycleSpeed(Number(e.target.value))}
            />
            <span className="w-12 shrink-0 text-end text-[12px] tabular-nums text-mist-300">
              {cycleSpeed.toFixed(1)}
            </span>
          </div>
        </div>

        {/* Fog */}
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-[12px] text-mist-400">الضباب</span>
          <input
            type="range"
            className="h-4 min-w-0 flex-1"
            min={0}
            max={0.02}
            step={0.0005}
            value={fog}
            aria-label="الضباب"
            onChange={(e) => applyFog(Number(e.target.value))}
          />
          <span className="w-12 shrink-0 text-end text-[12px] tabular-nums text-mist-300">
            {Math.round((fog / 0.02) * 100)}%
          </span>
        </div>

        <div className="h-px bg-ink-700" />

        {/* Measure tool */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={measuring ? btnActive : btn}
              onClick={() => setMeasuring((v) => !v)}
            >
              {measuring ? 'إنهاء القياس' : 'قياس'}
            </button>
            <button type="button" className={btn} onClick={resetMeasure}>
              امسح
            </button>
            <span className="text-[12px] tabular-nums text-mist-300">
              {distance !== null ? `${distance.toFixed(2)} م` : ''}
            </span>
          </div>
          {measuring && distance === null && (
            <p className="text-[11px] text-mist-400">انقر نقطتين على الأرض للقياس.</p>
          )}
        </div>

        <div className="h-px bg-ink-700" />

        {/* Reference grid */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className={gridOn ? btnActive : btn}
            onClick={() => setGridOn((v) => !v)}
          >
            {gridOn ? 'إخفاء الشبكة' : 'شبكة إسناد'}
          </button>
          <div className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-[12px] text-mist-400">التباعد</span>
            <input
              type="range"
              className="h-4 min-w-0 flex-1"
              min={2}
              max={50}
              step={1}
              value={spacing}
              aria-label="التباعد"
              onChange={(e) => setSpacing(Number(e.target.value))}
            />
            <span className="w-12 shrink-0 text-end text-[12px] tabular-nums text-mist-300">
              {spacing} م
            </span>
          </div>
        </div>

        <div className="h-px bg-ink-700" />

        {/* Compass */}
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-[12px] text-mist-400">البوصلة</span>
          <svg viewBox="0 0 100 100" className="h-16 w-16 shrink-0" aria-label="البوصلة">
            <circle cx="50" cy="50" r="46" fill="none" stroke="var(--color-ink-600)" strokeWidth="2" />
            <text x="50" y="16" textAnchor="middle" fontSize="12" fill="var(--color-mist-400)">
              N
            </text>
            {/* Needle rotates opposite to the camera yaw so N stays world-fixed. */}
            <g transform={`rotate(${-heading} 50 50)`}>
              <polygon points="50,14 44,52 56,52" fill="var(--color-brand-500)" />
              <polygon points="50,86 44,52 56,52" fill="var(--color-mist-400)" />
            </g>
          </svg>
          <span className="text-[12px] tabular-nums text-mist-300">
            {Math.round((heading + 360) % 360)}°
          </span>
        </div>

        <div className="h-px bg-ink-700" />

        {/* Shortcuts help */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className={showHelp ? btnActive : btn}
            onClick={() => setShowHelp((v) => !v)}
          >
            مساعدة الاختصارات
          </button>
          {showHelp && (
            <ul className="flex flex-col gap-1 rounded-md border border-ink-600 bg-ink-800 p-2.5">
              {shortcuts.map((s) => (
                <li key={s.key} className="flex items-center justify-between text-[11px]">
                  <span className="text-mist-300">{s.desc}</span>
                  <kbd className="rounded bg-ink-700 px-1.5 py-0.5 font-mono text-mist-200" dir="ltr">
                    {s.key}
                  </kbd>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  )
}
