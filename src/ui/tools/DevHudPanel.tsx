import { useCallback, useEffect, useRef, useState } from 'react'
import { Panel } from '../Chrome'

/**
 * Developer HUD. Like the other tool panels this is a pure add-on: it reads and
 * writes the already-booted engine that Viewport publishes as `window.sim` and
 * imports nothing from the engine module. All numeric readouts render *inside*
 * this panel — the only thing that ever touches the 3D scene here is toggling
 * flags Babylon already owns (forceWireframe / showBoundingBox), never new meshes.
 */

type SimLike = {
  engine: any
  scene: any
  camera: any
  field: any
  painter: any
  region?: any
  vehicle: any
  model: any
  // warmup(seconds) is a public method on Sim; used to advance one physics step
  // while paused. Optional here so the panel degrades gracefully if it is gone.
  warmup?: (seconds: number) => void
}

type StoreLike = {
  getState(): {
    settings: { running: boolean }
    set(key: 'running', value: boolean): void
  }
}

function getSim(): SimLike | undefined {
  return (window as unknown as { sim?: SimLike }).sim
}

function getStore(): StoreLike | undefined {
  return (window as unknown as { __simStore?: StoreLike }).__simStore
}

const MAX_SAMPLES = 60 // ~12s of history at 5 Hz

interface Stats {
  drawCalls: number
  meshes: number
  activeMeshes: number
  vertices: number
  materials: number
  textures: number
}

const EMPTY_STATS: Stats = {
  drawCalls: 0,
  meshes: 0,
  activeMeshes: 0,
  vertices: 0,
  materials: 0,
  textures: 0,
}

/** SVG sparkline for a series normalised against its own running max. */
function Sparkline({
  values,
  color,
  height = 34,
}: {
  values: number[]
  color: string
  height?: number
}) {
  const width = 180
  if (values.length < 2) {
    return <svg width={width} height={height} className="w-full" />
  }
  const max = Math.max(1, ...values)
  const step = width / (MAX_SAMPLES - 1)
  // Right-align newest sample so the graph scrolls left as it fills.
  const offset = (MAX_SAMPLES - values.length) * step
  const points = values
    .map((v, i) => {
      const x = offset + i * step
      const y = height - (v / max) * (height - 2) - 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="w-full">
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-mist-400">{label}</span>
      <span className="text-[12px] tabular-nums text-mist-200">{value}</span>
    </div>
  )
}

export function DevHudPanel() {
  // --- Live FPS / frame-time sparklines (5 Hz) ---
  const [fpsSeries, setFpsSeries] = useState<number[]>([])
  const [dtSeries, setDtSeries] = useState<number[]>([])
  const [fps, setFps] = useState(0)
  const [frameMs, setFrameMs] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => {
      const sim = getSim()
      if (!sim) return
      const f = sim.engine.getFps()
      const dt = sim.engine.getDeltaTime()
      setFps(f)
      setFrameMs(dt)
      setFpsSeries((prev) => [...prev, f].slice(-MAX_SAMPLES))
      setDtSeries((prev) => [...prev, dt].slice(-MAX_SAMPLES))
    }, 200)
    return () => window.clearInterval(id)
  }, [])

  // --- Stats table (2 Hz) ---
  const [stats, setStats] = useState<Stats>(EMPTY_STATS)

  useEffect(() => {
    const id = window.setInterval(() => {
      const sim = getSim()
      if (!sim) return
      const scene = sim.scene
      setStats({
        drawCalls: sim.engine._drawCalls?.current ?? 0,
        meshes: scene.meshes.length,
        activeMeshes: scene.getActiveMeshes().length,
        vertices: scene.getTotalVertices(),
        materials: scene.materials.length,
        textures: scene.textures.length,
      })
    }, 500)
    return () => window.clearInterval(id)
  }, [])

  // --- Wireframe toggle ---
  const [wireframe, setWireframe] = useState(false)
  const toggleWireframe = useCallback(() => {
    const sim = getSim()
    if (!sim) return
    const next = !wireframe
    sim.scene.forceWireframe = next
    setWireframe(next)
  }, [wireframe])

  // --- Bounding boxes toggle. We only flip meshes we ourselves turned on, so
  //     restoring never clobbers a box some other tool enabled. Skyboxes are
  //     skipped — an AABB around a 5000-unit dome is just noise. ---
  const [bounds, setBounds] = useState(false)
  const touchedRef = useRef<any[]>([])
  const toggleBounds = useCallback(() => {
    const sim = getSim()
    if (!sim) return
    if (!bounds) {
      const touched: any[] = []
      for (const m of sim.scene.meshes as any[]) {
        const name = String(m.name ?? '').toLowerCase()
        if (name.includes('skybox') || name.includes('skydome')) continue
        if (!m.showBoundingBox) {
          m.showBoundingBox = true
          touched.push(m)
        }
      }
      touchedRef.current = touched
      setBounds(true)
    } else {
      for (const m of touchedRef.current) {
        // Guard: mesh may have been disposed while boxes were on.
        if (!m.isDisposed?.()) m.showBoundingBox = false
      }
      touchedRef.current = []
      setBounds(false)
    }
  }, [bounds])

  // Restore any bounding boxes we enabled if the panel unmounts while ON.
  useEffect(() => {
    return () => {
      for (const m of touchedRef.current) {
        if (!m.isDisposed?.()) m.showBoundingBox = false
      }
      touchedRef.current = []
    }
  }, [])

  // --- Coordinate readout: pick the ground under the cursor while ON. Throttled
  //     to ~20 Hz because scene.pick raycasts every call. ---
  const [coordsOn, setCoordsOn] = useState(false)
  const [coords, setCoords] = useState<{ x: number; y: number; z: number } | null>(null)
  useEffect(() => {
    if (!coordsOn) {
      setCoords(null)
      return
    }
    let last = 0
    const onMove = () => {
      const now = performance.now()
      if (now - last < 50) return
      last = now
      const sim = getSim()
      if (!sim) return
      const scene = sim.scene
      const hit = scene.pick(scene.pointerX, scene.pointerY)
      if (hit?.hit && hit.pickedPoint) {
        setCoords({ x: hit.pickedPoint.x, y: hit.pickedPoint.y, z: hit.pickedPoint.z })
      }
    }
    // The engine renders into a canvas; listen on the window so the move is
    // caught regardless of which overlay is on top.
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [coordsOn])

  // --- Pause / single-step ---
  const pause = useCallback(() => {
    getStore()?.getState().set('running', false)
  }, [])
  const step = useCallback(() => {
    const sim = getSim()
    if (!sim) return
    // Advance one physics step if the engine exposes warmup; otherwise fall back
    // to re-rendering a single frame so the view at least refreshes.
    if (typeof sim.warmup === 'function') sim.warmup(1 / 60)
    else sim.scene.render()
  }, [])

  // --- Hardware scaling (render resolution). Lower = sharper/slower. ---
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const sim = getSim()
    if (sim) setScale(sim.engine.getHardwareScalingLevel())
  }, [])
  const onScale = useCallback((v: number) => {
    setScale(v)
    getSim()?.engine.setHardwareScalingLevel(v)
  }, [])

  const toggleBtn = (on: boolean) =>
    `rounded-lg px-3 py-2 text-[12px] transition-colors ${
      on ? 'bg-brand-500 text-white hover:bg-brand-400' : 'bg-ink-700 text-mist-200 hover:bg-ink-600'
    }`

  return (
    <Panel title="أدوات المطوّر" className="min-w-0" bodyClassName="min-h-0 overflow-y-auto p-4">
      <div className="flex flex-col gap-4" dir="rtl">
        {/* 1. FPS + frame-time sparklines */}
        <section className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-mist-400">الإطارات/ث</span>
            <span className="text-[12px] tabular-nums text-mist-200">{Math.round(fps)}</span>
          </div>
          <Sparkline values={fpsSeries} color="var(--color-brand-500)" />
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-mist-400">زمن الإطار</span>
            <span className="text-[12px] tabular-nums text-mist-200">{frameMs.toFixed(1)}ms</span>
          </div>
          <Sparkline values={dtSeries} color="var(--color-mist-400)" />
        </section>

        {/* 2. Stats table */}
        <section className="flex flex-col gap-1 border-t border-ink-700 pt-3">
          <StatRow label="استدعاءات الرسم" value={String(stats.drawCalls)} />
          <StatRow label="الشبكات" value={String(stats.meshes)} />
          <StatRow label="الشبكات النشطة" value={String(stats.activeMeshes)} />
          <StatRow label="الرؤوس" value={stats.vertices.toLocaleString('en-US')} />
          <StatRow label="المواد" value={String(stats.materials)} />
          <StatRow label="القوام" value={String(stats.textures)} />
        </section>

        {/* 3 + 4. Debug view toggles */}
        <section className="flex flex-col gap-2 border-t border-ink-700 pt-3">
          <div className="flex gap-2">
            <button type="button" className={`flex-1 ${toggleBtn(wireframe)}`} onClick={toggleWireframe}>
              إطار سلكي
            </button>
            <button type="button" className={`flex-1 ${toggleBtn(bounds)}`} onClick={toggleBounds}>
              صناديق الإحاطة
            </button>
          </div>

          {/* 5. Coordinate readout */}
          <button
            type="button"
            className={toggleBtn(coordsOn)}
            onClick={() => setCoordsOn((v) => !v)}
          >
            قراءة الإحداثيات {coordsOn ? '(مُفعّل)' : ''}
          </button>
          {coordsOn && (
            <div className="rounded-md border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-[11px] tabular-nums text-mist-300" dir="ltr">
              {coords
                ? `x ${coords.x.toFixed(2)}   y ${coords.y.toFixed(2)}   z ${coords.z.toFixed(2)}`
                : '— حرّك المؤشر فوق الأرض —'}
            </div>
          )}
        </section>

        {/* 6. Pause / step */}
        <section className="flex gap-2 border-t border-ink-700 pt-3">
          <button
            type="button"
            className="flex-1 rounded-lg bg-ink-700 px-3 py-2 text-[12px] text-mist-200 transition-colors hover:bg-ink-600"
            onClick={pause}
          >
            إيقاف
          </button>
          <button
            type="button"
            className="flex-1 rounded-lg bg-ink-700 px-3 py-2 text-[12px] text-mist-200 transition-colors hover:bg-ink-600"
            onClick={step}
          >
            خطوة
          </button>
        </section>

        {/* 7. Hardware scaling slider */}
        <section className="flex flex-col gap-1 border-t border-ink-700 pt-3">
          <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-[12px] text-mist-400">مقياس الدقّة</span>
            <input
              type="range"
              className="h-4 min-w-0 flex-1"
              min={0.5}
              max={2}
              step={0.1}
              value={scale}
              aria-label="مقياس الدقّة"
              onChange={(e) => onScale(Number(e.target.value))}
            />
            <span className="w-12 shrink-0 text-end text-[12px] tabular-nums text-mist-300">
              {scale.toFixed(1)}×
            </span>
          </div>
          <p className="text-[11px] leading-4 text-mist-400">0.5 أوضح · 2 أسرع</p>
        </section>
      </div>
    </Panel>
  )
}
