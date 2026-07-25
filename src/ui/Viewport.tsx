import { useEffect, useRef, useState } from 'react'
import { Sim } from '../engine/Sim'
import { useSim } from '../store/simStore'

/**
 * Hosts the WebGL canvas and owns the Sim lifetime.
 *
 * The engine is booted exactly once per mount even under StrictMode's double
 * effect invocation — booting twice would leave two render loops fighting over
 * the same canvas.
 */
export function Viewport({ children }: { children?: React.ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const simRef = useRef<Sim | null>(null)
  const disposeTimer = useRef<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loadProgress = useSim((s) => s.loadProgress)
  const ready = useSim((s) => s.engineReady)

  useEffect(() => {
    // StrictMode mounts, unmounts and remounts. Refs survive that, so a pending
    // teardown from the throwaway pass is cancelled here instead of killing the
    // engine mid-boot.
    if (disposeTimer.current !== null) {
      clearTimeout(disposeTimer.current)
      disposeTimer.current = null
    }

    const canvas = canvasRef.current
    if (!canvas) return

    if (!simRef.current) {
      const sim = new Sim(canvas)
      simRef.current = sim
      ;(window as unknown as { sim: Sim }).sim = sim

      sim.boot().catch((err) => {
        console.error('[sim] boot failed', err)
        setError(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
      })
    }

    return () => {
      disposeTimer.current = window.setTimeout(() => {
        simRef.current?.dispose()
        simRef.current = null
        disposeTimer.current = null
      }, 150)
    }
  }, [])

  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-xl bg-black"
      data-boot-progress={loadProgress}
    >
      <canvas ref={canvasRef} className="h-full w-full" />

      {!ready && !error && (
        <div className="absolute inset-0 grid place-content-center gap-3 bg-ink-950/90 text-center">
          <div className="text-sm text-mist-300">جارٍ تحميل المحاكاة…</div>
          <div className="mx-auto h-1.5 w-56 overflow-hidden rounded-full bg-ink-700">
            <div
              className="h-full rounded-full bg-brand-500 transition-[width] duration-200"
              style={{ width: `${Math.round(loadProgress * 100)}%` }}
            />
          </div>
          <div className="text-xs tabular-nums text-mist-400">
            {Math.round(loadProgress * 100)}%
          </div>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 overflow-auto bg-ink-950/95 p-6" dir="ltr">
          <div className="mb-2 text-sm font-semibold text-bad-500">Engine failed to start</div>
          <pre className="text-xs whitespace-pre-wrap text-mist-400">{error}</pre>
        </div>
      )}

      {children}
    </div>
  )
}
