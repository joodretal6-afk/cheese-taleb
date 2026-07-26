import { useCallback, useEffect, useRef, useState } from 'react'
import { Tools, Vector3 } from '@babylonjs/core'
import { Panel } from '../Chrome'

/**
 * Camera dev-tools. Everything here operates on the already-booted engine that
 * Viewport exposes as `window.sim`; nothing is imported from the engine module
 * to keep this panel a pure add-on.
 *
 * The one non-obvious fact that shapes the whole design: Sim.tick() calls its
 * chase-camera update every frame (even while paused) and then renders. So a
 * one-shot `camera.position = ...` is wiped on the very next frame. The robust
 * way to own the camera is to overwrite it *after* the chase update — i.e. from
 * scene.onBeforeRenderObservable, which fires inside scene.render(), which
 * tick() calls last. While our observable is active we fully drive the camera;
 * removing it hands control straight back to the chase rig.
 *
 * Because of that, top-down / frame / bookmark aren't momentary snaps — they
 * engage the same manual-override that free-fly uses (turning the fly switch
 * on) and drop you at the requested pose, from which WASD keeps working.
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

// Persisted camera bookmarks: six slots of position + look-at target.
type Bookmark = { pos: [number, number, number]; target: [number, number, number] }
const BM_KEY = 'cam.bookmarks.v1'
const SLOTS = 6

function loadBookmarks(): (Bookmark | null)[] {
  try {
    const raw = localStorage.getItem(BM_KEY)
    if (!raw) return Array<Bookmark | null>(SLOTS).fill(null)
    const parsed = JSON.parse(raw) as (Bookmark | null)[]
    // Normalise length so a schema bump never leaves a short array.
    const out: (Bookmark | null)[] = Array<Bookmark | null>(SLOTS).fill(null)
    for (let i = 0; i < SLOTS; i++) out[i] = parsed[i] ?? null
    return out
  } catch {
    return Array<Bookmark | null>(SLOTS).fill(null)
  }
}

/** Mutable state the render-loop observable reads without triggering React. */
type FlyState = {
  pos: Vector3
  yaw: number // heading, 0 = +Z, matches the chase rig's convention
  pitch: number // -PI/2 looks straight down
  speed: number
  fov: number
  keys: Set<string>
  dragging: boolean
  lastX: number
  lastY: number
}

const PITCH_LIMIT = Math.PI / 2 - 0.02

export function CameraToolsPanel() {
  const [flying, setFlying] = useState(false)
  const [speed, setSpeed] = useState(20)
  const [fov, setFov] = useState(0.85)
  const [bookmarks, setBookmarks] = useState<(Bookmark | null)[]>(() => loadBookmarks())
  const [note, setNote] = useState<string | null>(null)

  // Live state the observable mutates each frame; a ref so no re-render churn.
  const flyRef = useRef<FlyState>({
    pos: new Vector3(0, 12, -20),
    yaw: 0,
    pitch: 0,
    speed: 20,
    fov: 0.85,
    keys: new Set<string>(),
    dragging: false,
    lastX: 0,
    lastY: 0,
  })
  // Registered observer / listeners so we can tear them down precisely.
  const observerRef = useRef<any>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const prevRunningRef = useRef<boolean | null>(null)

  // Keep the mutable fly state in step with the React sliders.
  useEffect(() => {
    flyRef.current.speed = speed
  }, [speed])
  useEffect(() => {
    flyRef.current.fov = fov
  }, [fov])

  // Direction basis from yaw/pitch, matching Sim's chase convention:
  // forward = (sin(yaw)cos(pitch), sin(pitch), cos(yaw)cos(pitch)).
  const basis = (f: FlyState) => {
    const cp = Math.cos(f.pitch)
    const forward = new Vector3(
      Math.sin(f.yaw) * cp,
      Math.sin(f.pitch),
      Math.cos(f.yaw) * cp,
    )
    // Right-hand strafe in the horizontal plane (Babylon is left-handed).
    const right = new Vector3(Math.cos(f.yaw), 0, -Math.sin(f.yaw))
    return { forward, right }
  }

  // Point the camera from an explicit position/target, deriving yaw & pitch so
  // free-fly resumes cleanly from wherever a snap dropped us.
  const applyPose = (sim: SimLike, pos: Vector3, target: Vector3) => {
    const f = flyRef.current
    f.pos.copyFrom(pos)
    const dir = target.subtract(pos)
    const len = dir.length()
    if (len > 1e-4) {
      dir.scaleInPlace(1 / len)
      f.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.asin(dir.y)))
      f.yaw = Math.atan2(dir.x, dir.z)
    }
    sim.camera.position.copyFrom(pos)
    sim.camera.setTarget(target)
  }

  const startFly = useCallback(() => {
    const sim = getSim()
    if (!sim) return
    const canvas: HTMLCanvasElement | null = sim.engine.getRenderingCanvas?.() ?? null
    canvasRef.current = canvas

    // Seed the fly pose from the camera's current pose so it doesn't jump.
    const f = flyRef.current
    f.pos.copyFrom(sim.camera.position)
    // The chase rig steers via setTarget; read direction back off the camera.
    const fwd: Vector3 =
      typeof sim.camera.getForwardRay === 'function'
        ? sim.camera.getForwardRay().direction
        : new Vector3(0, 0, 1)
    f.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.asin(fwd.y || 0)))
    f.yaw = Math.atan2(fwd.x, fwd.z)
    f.keys.clear()
    f.dragging = false

    // Pause physics so WASD flies the camera instead of also driving the truck,
    // and so the vehicle doesn't wander off while we look around. Restored on OFF.
    const store = getStore()
    if (store) {
      prevRunningRef.current = store.getState().settings.running
      store.getState().set('running', false)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      // Don't hijack typing in inputs.
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      f.keys.add(e.code)
    }
    const onKeyUp = (e: KeyboardEvent) => f.keys.delete(e.code)
    const onDown = (e: PointerEvent) => {
      f.dragging = true
      f.lastX = e.clientX
      f.lastY = e.clientY
    }
    const onUp = () => {
      f.dragging = false
    }
    const onMove = (e: PointerEvent) => {
      if (!f.dragging) return
      const dx = e.clientX - f.lastX
      const dy = e.clientY - f.lastY
      f.lastX = e.clientX
      f.lastY = e.clientY
      const sens = 0.0045
      f.yaw += dx * sens
      f.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, f.pitch - dy * sens))
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    canvas?.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointermove', onMove)

    const observer = sim.scene.onBeforeRenderObservable.add(() => {
      const s = getSim()
      if (!s) return
      // Real elapsed seconds, clamped against a stalled frame.
      const dt = Math.min(0.05, s.engine.getDeltaTime() / 1000)
      const { forward, right } = basis(f)
      const step = f.speed * dt
      const move = (v: Vector3, k: number) => f.pos.addInPlace(v.scale(k))
      if (f.keys.has('KeyW') || f.keys.has('ArrowUp')) move(forward, step)
      if (f.keys.has('KeyS') || f.keys.has('ArrowDown')) move(forward, -step)
      if (f.keys.has('KeyD') || f.keys.has('ArrowRight')) move(right, step)
      if (f.keys.has('KeyA') || f.keys.has('ArrowLeft')) move(right, -step)
      if (f.keys.has('KeyE') || f.keys.has('Space')) move(Vector3.Up(), step)
      if (f.keys.has('KeyQ') || f.keys.has('ShiftLeft')) move(Vector3.Up(), -step)

      // Overwrite whatever the chase rig set this frame — we run after it.
      s.camera.position.copyFrom(f.pos)
      s.camera.setTarget(f.pos.add(forward))
      // Own FOV too, so the panel's FOV slider is authoritative while flying.
      s.camera.fov = f.fov
    })
    observerRef.current = observer

    // Remember the listeners on the observer object for teardown.
    ;(observer as any).__cleanup = () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      canvas?.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])

  const stopFly = useCallback(() => {
    const sim = getSim()
    const observer = observerRef.current
    if (observer) {
      ;(observer as any).__cleanup?.()
      sim?.scene.onBeforeRenderObservable.remove(observer)
      observerRef.current = null
    }
    flyRef.current.keys.clear()
    flyRef.current.dragging = false
    // Restore the run state we paused when engaging manual control.
    const store = getStore()
    if (store && prevRunningRef.current !== null) {
      store.getState().set('running', prevRunningRef.current)
      prevRunningRef.current = null
    }
  }, [])

  // Master toggle for manual camera control.
  useEffect(() => {
    if (flying) startFly()
    else stopFly()
    return () => {
      // Unmount while flying must not leave a dangling observer/listeners.
      if (observerRef.current) stopFly()
    }
  }, [flying, startFly, stopFly])

  // Ensure a manual override is running, then drop the camera at pos->target.
  const snapTo = (pos: Vector3, target: Vector3) => {
    const sim = getSim()
    if (!sim) return
    if (!flying) {
      setFlying(true) // engages the override on the next effect run
      // startFly hasn't attached yet; stash the pose so the first frame uses it.
      applyPose(sim, pos, target)
      // Re-apply after the observer attaches (next tick) to defeat the seed.
      window.setTimeout(() => {
        const s = getSim()
        if (s) applyPose(s, pos, target)
      }, 0)
    } else {
      applyPose(sim, pos, target)
    }
  }

  // --- 2. Top-down: hover high over the vehicle (or origin) looking down. ---
  const topDown = () => {
    const sim = getSim()
    if (!sim) return
    const c: Vector3 =
      sim.vehicle && typeof sim.vehicle.position?.clone === 'function'
        ? sim.vehicle.position.clone()
        : new Vector3(0, 0, 0)
    const size: number = sim.field?.worldSize ?? 200
    const h = Math.max(40, size * 0.4)
    const eye = new Vector3(c.x, c.y + h, c.z)
    // Nudge the target a hair on Z so setTarget never gets a straight-down
    // degenerate look-at (the same trap Sim guards against).
    const look = new Vector3(c.x, c.y, c.z + 0.001)
    snapTo(eye, look)
    setNote(null)
  }

  // --- 5. Frame the whole scene from its combined world bounds. ---
  const frameScene = () => {
    const sim = getSim()
    if (!sim) return
    let min = new Vector3(Infinity, Infinity, Infinity)
    let max = new Vector3(-Infinity, -Infinity, -Infinity)
    let any = false
    for (const m of sim.scene.meshes as any[]) {
      // Skip the skybox and anything not currently drawable / has no geometry.
      const name: string = m.name ?? ''
      if (/sky/i.test(name)) continue
      if (m.isEnabled?.() === false) continue
      if (typeof m.getTotalVertices === 'function' && m.getTotalVertices() === 0) continue
      const bi = m.getBoundingInfo?.()
      if (!bi) continue
      const bmin: Vector3 = bi.boundingBox.minimumWorld
      const bmax: Vector3 = bi.boundingBox.maximumWorld
      min = Vector3.Minimize(min, bmin)
      max = Vector3.Maximize(max, bmax)
      any = true
    }
    if (!any) {
      setNote('لا توجد أجسام لتأطيرها')
      return
    }
    const center = min.add(max).scale(0.5)
    const radius = max.subtract(min).length() * 0.5
    const fovNow: number = sim.camera.fov ?? 0.85
    // Distance so the sphere of `radius` fits the vertical FOV, with headroom.
    const dist = (radius / Math.tan(fovNow * 0.5)) * 1.15
    // Look down from a 3/4 angle for a readable framing.
    const dir = new Vector3(0.4, 0.55, -0.75).normalize()
    const eye = center.add(dir.scale(dist))
    snapTo(eye, center)
    setNote(null)
  }

  // --- 4. Bookmarks: save current pose to a slot; click to fly there. ---
  const persist = (next: (Bookmark | null)[]) => {
    setBookmarks(next)
    try {
      localStorage.setItem(BM_KEY, JSON.stringify(next))
    } catch {
      /* storage may be unavailable (private mode); bookmarks stay in-memory */
    }
  }

  const saveBookmark = (i: number) => {
    const sim = getSim()
    if (!sim) return
    const p: Vector3 = sim.camera.position
    // Reconstruct a look-at a metre ahead from the camera's forward ray.
    const fwd: Vector3 =
      typeof sim.camera.getForwardRay === 'function'
        ? sim.camera.getForwardRay().direction
        : new Vector3(0, 0, 1)
    const t = p.add(fwd.scale(10))
    const next = bookmarks.slice()
    next[i] = { pos: [p.x, p.y, p.z], target: [t.x, t.y, t.z] }
    persist(next)
    setNote(`حُفظ الموضع ${i + 1}`)
  }

  const gotoBookmark = (i: number) => {
    const b = bookmarks[i]
    if (!b) return
    snapTo(new Vector3(...b.pos), new Vector3(...b.target))
    setNote(`الموضع ${i + 1}`)
  }

  // --- 6. Screenshot → PNG download. ---
  const [shooting, setShooting] = useState(false)
  const screenshot = async () => {
    const sim = getSim()
    if (!sim || shooting) return
    setShooting(true)
    try {
      const canvas: HTMLCanvasElement | null = sim.engine.getRenderingCanvas?.() ?? null
      const width = canvas?.width ?? 1920
      const height = canvas?.height ?? 1080
      const data = await Tools.CreateScreenshotUsingRenderTargetAsync(
        sim.engine,
        sim.scene.activeCamera,
        { width, height },
      )
      const a = document.createElement('a')
      a.href = data
      a.download = `mts-shot-${Date.now()}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setNote('تم حفظ اللقطة')
    } catch {
      setNote('تعذّر التقاط اللقطة')
    } finally {
      setShooting(false)
    }
  }

  // --- 7. FOV slider → camera.fov (authoritative while flying via observer). ---
  const onFov = (v: number) => {
    setFov(v)
    const sim = getSim()
    if (sim) sim.camera.fov = v
  }

  const btn =
    'rounded-lg bg-ink-700 px-3 py-2 text-[12px] text-mist-200 transition-colors hover:bg-ink-600'

  return (
    <Panel title="أدوات الكاميرا" className="min-w-0" bodyClassName="min-h-0 overflow-y-auto p-4">
      <div className="flex flex-col gap-4" dir="rtl">
        {/* 1 + 3: free-fly toggle and its speed */}
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-mist-300">الطيران الحر (WASD + سحب)</span>
            <button
              type="button"
              onClick={() => setFlying((v) => !v)}
              aria-pressed={flying}
              className={`rounded-lg px-3 py-2 text-[12px] transition-colors ${
                flying ? 'bg-brand-500 text-white hover:bg-brand-400' : btn
              }`}
            >
              {flying ? 'مُفعّل' : 'معطّل'}
            </button>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-[12px] text-mist-400">السرعة</span>
            <input
              type="range"
              className="h-4 min-w-0 flex-1"
              min={2}
              max={120}
              step={1}
              value={speed}
              aria-label="سرعة الكاميرا"
              onChange={(e) => setSpeed(Number(e.target.value))}
            />
            <span className="w-12 shrink-0 text-end text-[12px] tabular-nums text-mist-300">
              {speed}
            </span>
          </div>
          <p className="text-[11px] leading-4 text-mist-400">
            أثناء الطيران تتوقف الفيزياء مؤقتاً وتُدار الكاميرا يدوياً.
          </p>
        </div>

        {/* 2 + 5: quick views */}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={btn} onClick={topDown}>
            رؤية علوية
          </button>
          <button type="button" className={btn} onClick={frameScene}>
            أطّر المشهد
          </button>
        </div>

        {/* 4: bookmarks */}
        <div className="flex flex-col gap-2">
          <span className="text-[12px] text-mist-300">مواضع محفوظة</span>
          <div className="grid grid-cols-3 gap-2">
            {bookmarks.map((b, i) => (
              <div key={i} className="flex overflow-hidden rounded-lg border border-ink-600">
                <button
                  type="button"
                  disabled={!b}
                  onClick={() => gotoBookmark(i)}
                  title={b ? `اذهب للموضع ${i + 1}` : 'فارغ'}
                  className={`min-w-0 flex-1 px-2 py-1.5 text-[12px] tabular-nums transition-colors ${
                    b
                      ? 'bg-ink-700 text-mist-200 hover:bg-ink-600'
                      : 'cursor-default bg-ink-800 text-mist-400'
                  }`}
                >
                  {i + 1}
                </button>
                <button
                  type="button"
                  onClick={() => saveBookmark(i)}
                  title={`احفظ ${i + 1}`}
                  className="border-s border-ink-600 bg-ink-800 px-2 py-1.5 text-[11px] text-mist-400 transition-colors hover:bg-ink-700 hover:text-mist-200"
                >
                  حفظ
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* 7: FOV */}
        <div className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-[12px] text-mist-400">زاوية الرؤية</span>
          <input
            type="range"
            className="h-4 min-w-0 flex-1"
            min={0.3}
            max={1.6}
            step={0.01}
            value={fov}
            aria-label="زاوية الرؤية"
            onChange={(e) => onFov(Number(e.target.value))}
          />
          <span className="w-12 shrink-0 text-end text-[12px] tabular-nums text-mist-300">
            {Math.round((fov * 180) / Math.PI)}°
          </span>
        </div>

        {/* 6: screenshot */}
        <button
          type="button"
          disabled={shooting}
          onClick={() => void screenshot()}
          className="rounded-lg bg-brand-500 px-3 py-2 text-[12px] text-white transition-colors hover:bg-brand-400 disabled:opacity-40"
        >
          {shooting ? 'جارٍ الالتقاط…' : 'التقاط لقطة (PNG)'}
        </button>

        {note && (
          <p className="text-[11px] leading-4 text-mist-300" aria-live="polite">
            {note}
          </p>
        )}
      </div>
    </Panel>
  )
}
