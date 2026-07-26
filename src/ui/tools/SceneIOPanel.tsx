import { useCallback, useEffect, useRef, useState } from 'react'
import { GLTF2Export } from '@babylonjs/serializers'
import { Panel } from '../Chrome'

/**
 * Project save / load / export tools.
 *
 * The panel deliberately talks to the *store* (window.__simStore) for state and
 * to `window.sim` only for the GLB export. State lives in the store because a
 * project is more than the current scene graph — it is the settings the user
 * dialled in and the region they baked, both of which survive a reload.
 */

// Minimal shapes we rely on. Babylon subfields stay `any` to avoid import churn.
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

// The settings block the store exposes. Kept structural so we never import the
// store's types (integration is done separately and must stay decoupled).
type Settings = {
  timeOfDay: number
  weather: string
  mudIntensity: number
  humidity: number
  temperature: number
  terrainQuality: string
  running: boolean
}

type StoreState = {
  settings: Settings
  region?: unknown
  set: (key: string, value: unknown) => void
  patchRegion?: (region: unknown) => void
}

type StoreLike = { getState: () => StoreState }

// A project bundle. `region` and `cameraBookmarks` may be absent.
interface Project {
  settings: Partial<Settings>
  region: unknown
  cameraBookmarks: unknown
  savedAt: number
}

// Sensible defaults mirror the store's initial settings. `terrainQuality` is
// left untouched by reset because it is a performance choice tied to the user's
// hardware, not part of the "look" a reset is meant to restore.
const DEFAULTS: Omit<Settings, 'terrainQuality'> = {
  timeOfDay: 12,
  weather: 'overcast',
  mudIntensity: 0.85,
  humidity: 0.7,
  temperature: 0.6,
  running: false,
}

const AUTOSAVE_KEY = 'project.autosave'
const SNAPSHOTS_KEY = 'snapshots'
const BOOKMARKS_KEY = 'cam.bookmarks'

function getSim(): SimLike | undefined {
  return (window as unknown as { sim?: SimLike }).sim
}

function getStore(): StoreLike | undefined {
  return (window as unknown as { __simStore?: StoreLike }).__simStore
}

/** Collect the full project bundle from the store + localStorage. */
function collectProject(): Project | null {
  const store = getStore()
  if (!store) return null
  const state = store.getState()
  let bookmarks: unknown = null
  try {
    const raw = localStorage.getItem(BOOKMARKS_KEY)
    if (raw) bookmarks = JSON.parse(raw)
  } catch {
    // A corrupt bookmarks blob must not sink the whole save.
    bookmarks = null
  }
  return {
    settings: state.settings,
    region: state.region ?? null,
    cameraBookmarks: bookmarks,
    savedAt: Date.now(),
  }
}

/** Apply a decoded project back onto the store. Every step is guarded. */
function applyProject(project: Partial<Project>): void {
  const store = getStore()
  if (!store) return
  const state = store.getState()
  const settings = project.settings
  if (settings && typeof settings === 'object') {
    for (const [key, value] of Object.entries(settings)) {
      // `running` is a live toggle; restoring it paused avoids a project that
      // silently starts driving on load.
      if (key === 'running') continue
      try {
        state.set(key, value)
      } catch {
        // An unknown key from a newer/older file is ignored rather than fatal.
      }
    }
  }
  if (project.region != null && typeof state.patchRegion === 'function') {
    try {
      state.patchRegion(project.region)
    } catch {
      // Region shape mismatch — skip, keep the settings we already applied.
    }
  }
  if (project.cameraBookmarks != null) {
    try {
      localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(project.cameraBookmarks))
    } catch {
      // Storage full / disabled — bookmarks are non-critical.
    }
  }
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick so the click has certainly started the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

interface Snapshot {
  name: string
  savedAt: number
  project: Project
}

function loadSnapshots(): Snapshot[] {
  try {
    const raw = localStorage.getItem(SNAPSHOTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Snapshot[]) : []
  } catch {
    return []
  }
}

function storeSnapshots(list: Snapshot[]): void {
  try {
    localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(list))
  } catch {
    // Quota exceeded — nothing sane to do here but keep the UI responsive.
  }
}

const BTN = 'rounded-lg bg-ink-700 px-3 py-2 text-[12px] text-mist-200 transition-colors hover:bg-ink-600'
const BTN_PRIMARY = 'rounded-lg bg-brand-500 px-3 py-2 text-[12px] text-white transition-colors hover:bg-brand-400'

export function SceneIOPanel() {
  const [status, setStatus] = useState<string>('جاهز')
  const [lastSave, setLastSave] = useState<number | null>(null)
  const [autosave, setAutosave] = useState(false)
  const [hasAutosave, setHasAutosave] = useState(false)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [snapName, setSnapName] = useState('')
  const [exporting, setExporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // On mount: surface any existing autosave and load named snapshots.
  useEffect(() => {
    try {
      setHasAutosave(localStorage.getItem(AUTOSAVE_KEY) != null)
    } catch {
      setHasAutosave(false)
    }
    setSnapshots(loadSnapshots())
  }, [])

  const markSaved = useCallback((label: string) => {
    const now = Date.now()
    setLastSave(now)
    setStatus(label)
  }, [])

  // --- Feature 1: save project to a downloaded file. ---
  const saveProject = useCallback(() => {
    const project = collectProject()
    if (!project) {
      setStatus('المحرك غير جاهز')
      return
    }
    download('project.json', new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }))
    markSaved('تم حفظ المشروع')
  }, [markSaved])

  // --- Feature 2: load project from a chosen file. ---
  const loadProjectFile = useCallback(
    (file: File | undefined) => {
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result)) as Partial<Project>
          applyProject(parsed)
          setStatus('تم تحميل المشروع')
        } catch {
          setStatus('ملف غير صالح')
        }
      }
      reader.onerror = () => setStatus('تعذّرت قراءة الملف')
      reader.readAsText(file)
      // Reset so choosing the same file again re-fires onChange.
      if (fileRef.current) fileRef.current.value = ''
    },
    [],
  )

  // --- Feature 3: autosave loop. Writes the bundle to localStorage every 10s. ---
  useEffect(() => {
    if (!autosave) return
    const tick = () => {
      const project = collectProject()
      if (!project) return
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(project))
        setHasAutosave(true)
        markSaved('حفظ تلقائي')
      } catch {
        // Ignore quota errors; the loop keeps trying on the next tick.
      }
    }
    const id = window.setInterval(tick, 10_000)
    tick() // Write immediately so the toggle has visible effect.
    return () => window.clearInterval(id)
  }, [autosave, markSaved])

  const restoreAutosave = useCallback(() => {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY)
      if (!raw) return
      applyProject(JSON.parse(raw) as Partial<Project>)
      setStatus('تمت الاستعادة')
    } catch {
      setStatus('تعذّرت الاستعادة')
    }
  }, [])

  // --- Feature 4: export the scene as GLB. ---
  const exportGlb = useCallback(async () => {
    const sim = getSim()
    if (!sim?.scene) {
      setStatus('المحرك غير جاهز')
      return
    }
    setExporting(true)
    setStatus('جارٍ تصدير GLB…')
    try {
      const data = await GLTF2Export.GLBAsync(sim.scene, 'scene', {
        // Skip the skybox and other infinite/helper meshes — they bloat the
        // file and are not part of the authored content.
        shouldExportNode: (node: any) => {
          const name = String(node?.name ?? '').toLowerCase()
          if (name.includes('skybox') || name.includes('skybox_')) return false
          if (name.includes('__gizmo') || name.includes('helper')) return false
          if (node?.infiniteDistance) return false
          return true
        },
      })
      data.downloadFiles()
      markSaved('تم تصدير GLB')
    } catch (err) {
      setStatus(`فشل التصدير: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setExporting(false)
    }
  }, [markSaved])

  // --- Feature 5: named snapshots in localStorage. ---
  const saveSnapshot = useCallback(() => {
    const name = snapName.trim()
    if (!name) {
      setStatus('أدخل اسماً للقطة')
      return
    }
    const project = collectProject()
    if (!project) {
      setStatus('المحرك غير جاهز')
      return
    }
    const next = loadSnapshots().filter((s) => s.name !== name)
    next.unshift({ name, savedAt: Date.now(), project })
    storeSnapshots(next)
    setSnapshots(next)
    setSnapName('')
    markSaved(`حُفظت اللقطة "${name}"`)
  }, [snapName, markSaved])

  const restoreSnapshot = useCallback((s: Snapshot) => {
    applyProject(s.project)
    setStatus(`استُعيدت "${s.name}"`)
  }, [])

  const deleteSnapshot = useCallback((name: string) => {
    const next = loadSnapshots().filter((s) => s.name !== name)
    storeSnapshots(next)
    setSnapshots(next)
  }, [])

  // --- Feature 6: reset settings to defaults. ---
  const resetSettings = useCallback(() => {
    const store = getStore()
    if (!store) {
      setStatus('المحرك غير جاهز')
      return
    }
    const set = store.getState().set
    for (const [key, value] of Object.entries(DEFAULTS)) {
      try {
        set(key, value)
      } catch {
        // Skip any key the store no longer knows about.
      }
    }
    setStatus('تمت إعادة الضبط')
  }, [])

  return (
    <Panel title="المشروع" className="min-w-0" bodyClassName="min-h-0 overflow-y-auto p-4">
      <div className="flex flex-col gap-4" dir="rtl">
        {/* Save / load / export row */}
        <div className="flex flex-col gap-2">
          <span className="text-[12px] text-mist-400">المشروع</span>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className={BTN_PRIMARY} onClick={saveProject}>
              حفظ المشروع
            </button>
            <button type="button" className={BTN} onClick={() => fileRef.current?.click()}>
              تحميل المشروع
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => loadProjectFile(e.target.files?.[0] ?? undefined)}
          />
          <button
            type="button"
            className={BTN}
            disabled={exporting}
            onClick={() => void exportGlb()}
          >
            {exporting ? 'جارٍ التصدير…' : 'تصدير المشهد GLB'}
          </button>
        </div>

        {/* Autosave */}
        <div className="flex flex-col gap-2 border-t border-ink-700 pt-3">
          <label className="flex items-center gap-2 text-[12px] text-mist-300">
            <input
              type="checkbox"
              className="accent-brand-500"
              checked={autosave}
              onChange={(e) => setAutosave(e.target.checked)}
            />
            حفظ تلقائي كل 10 ثوانٍ
          </label>
          {hasAutosave && (
            <button type="button" className={BTN} onClick={restoreAutosave}>
              استعادة الحفظ التلقائي
            </button>
          )}
        </div>

        {/* Named snapshots */}
        <div className="flex flex-col gap-2 border-t border-ink-700 pt-3">
          <span className="text-[12px] text-mist-400">لقطات مسمّاة</span>
          <div className="flex gap-2">
            <input
              type="text"
              value={snapName}
              placeholder="اسم اللقطة"
              onChange={(e) => setSnapName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveSnapshot()
              }}
              className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-[12px] text-mist-200 outline-none focus:border-brand-500"
            />
            <button type="button" className={BTN} onClick={saveSnapshot}>
              حفظ لقطة
            </button>
          </div>
          {snapshots.length === 0 ? (
            <p className="text-[11px] text-mist-400">لا توجد لقطات محفوظة</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {snapshots.map((s) => (
                <li
                  key={s.name}
                  className="flex items-center gap-2 rounded-md bg-ink-800 px-2.5 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-[12px] text-mist-200">{s.name}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-mist-400">
                    {formatTime(s.savedAt)}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-[11px] text-brand-400 hover:text-brand-300"
                    onClick={() => restoreSnapshot(s)}
                  >
                    استعادة
                  </button>
                  <button
                    type="button"
                    className="shrink-0 text-[11px] text-mist-400 hover:text-bad-500"
                    onClick={() => deleteSnapshot(s.name)}
                  >
                    حذف
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Reset + status */}
        <div className="flex flex-col gap-2 border-t border-ink-700 pt-3">
          <button type="button" className={BTN} onClick={resetSettings}>
            إعادة الضبط
          </button>
          <div className="flex items-center justify-between text-[11px] text-mist-400">
            <span>{status}</span>
            <span className="tabular-nums">
              {lastSave != null ? `آخر حفظ: ${formatTime(lastSave)}` : 'لم يُحفظ بعد'}
            </span>
          </div>
        </div>
      </div>
    </Panel>
  )
}
