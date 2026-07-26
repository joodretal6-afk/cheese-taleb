import { useEffect, useMemo, useRef, useState } from 'react'
import { useSim } from '../store/simStore'
import { Panel } from './Chrome'
import { IconAssets, IconCheck, IconClose, IconMountain, IconReset } from './icons'
import {
  describeRegion,
  listRegions,
  loadRegion,
  regionSummaryArabic,
  type RegionStats,
} from '../engine/region/loadRegion'
import type { RegionData } from '../engine/region/types'
import {
  DEFAULT_PALETTE,
  parsePalette,
  serialisePalette,
  type Palette,
  type SurfaceKey,
  type SurfaceStyle,
} from '../engine/region/palette'

/** Extra load options. Optional on purpose: an engine that ignores them still works. */
interface RegionLoadOptions {
  /** OSM maps a single building in this whole square, so they are generated. */
  buildings: boolean
  /** Real build progress, so the bar reports the engine instead of guessing. */
  onStage?(stage: string, fraction: number): void
}

type SimWindow = Window & {
  sim?: {
    /** Takes the already-parsed file, so it is never read twice. */
    loadRegion?(source: RegionData, palette: Palette, options?: RegionLoadOptions): Promise<void>
    applyRegionPalette?(palette: Palette): void
    unloadRegion?(): Promise<void>
    regionInfo?(): { stats: RegionStats; buildings: number; surfaces: SurfaceKey[] } | null
    setBrush?(config: {
      mode?: 'off' | 'decal' | 'model'
      url?: string | null
      sizeM?: number
      rotationDeg?: number
    }): void
    brushUndo?(): number
    brushClear?(): void
    brushCount?(): number
  }
}

function simApi() {
  return (window as SimWindow).sim
}

/** Human names for the baked regions; the file only carries the slug. */
const REGION_LABEL: Record<string, string> = {
  khalidiya: 'الخالدية — المفرق',
}

/** Insertion order of DEFAULT_PALETTE is the canonical surface order. */
const KEYS = Object.keys(DEFAULT_PALETTE) as SurfaceKey[]

/** ODbL floor, shown before any region is loaded so attribution is never absent. */
const FALLBACK_ATTRIBUTION = '© مساهمو OpenStreetMap (ODbL) · بيانات الارتفاع: AWS Terrain Tiles'

/** DEFAULT_PALETTE is deep-frozen, so every editable copy has to be a real clone. */
function clonePalette(p: Palette): Palette {
  const out = {} as Palette
  for (const k of KEYS) out[k] = { ...p[k] }
  return out
}

export function RegionPanel() {
  const engineReady = useSim((s) => s.engineReady)
  const generated = useSim((s) => s.generated)
  // Region state lives in the store: this panel is unmounted every time the
  // user switches tab, and an unmounted panel would take the palette with it.
  const region = useSim((s) => s.region)
  const patchRegion = useSim((s) => s.patchRegion)

  const [names, setNames] = useState<string[]>([])
  const [name, setName] = useState(region.name)
  const [buildings, setBuildings] = useState(region.buildings)
  const [palette, setPalette] = useState<Palette>(
    () => (region.paletteJson && parsePalette(region.paletteJson)) || clonePalette(DEFAULT_PALETTE),
  )
  const [stats, setStats] = useState<RegionStats | null>(null)
  /** Buildings actually standing in the scene, which is not what the file says. */
  const [placed, setPlaced] = useState<number | null>(null)
  /** Keys this region has something to dress. Null until a region is loaded. */
  const [active, setActive] = useState<SurfaceKey[] | null>(null)
  const attribution = region.attribution
  const [stage, setStage] = useState<{ label: string; fraction: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [share, setShare] = useState('')
  const [picking, setPicking] = useState<SurfaceKey | null>(null)
  const creepRef = useRef<number | null>(null)

  // Every texture the app has produced so far, newest first. AIPanel already
  // fills this; PhotoStudio results land here as soon as it pushes them.
  const library = useMemo(
    () =>
      Object.values(generated)
        .flat()
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 12),
    [generated],
  )

  useEffect(() => {
    let alive = true
    listRegions()
      .then((list) => {
        if (!alive) return
        setNames(list)
        setName((n) => n || list[0] || '')
        if (list.length === 0) setError('لا توجد أي منطقة مبنية داخل التطبيق')
      })
      .catch(() => alive && setError('تعذّر البحث عن المناطق المبنية'))
    return () => {
      alive = false
      if (creepRef.current !== null) window.clearInterval(creepRef.current)
    }
  }, [])

  function stopCreep() {
    if (creepRef.current === null) return
    window.clearInterval(creepRef.current)
    creepRef.current = null
  }

  /**
   * The engine build reports no progress of its own, so the bar eases toward 92%
   * instead of freezing — an honest "still working", not a fabricated fraction.
   */
  function startCreep() {
    stopCreep()
    creepRef.current = window.setInterval(() => {
      setStage((st) => (st ? { ...st, fraction: st.fraction + (0.92 - st.fraction) * 0.07 } : st))
    }, 140)
  }

  async function load() {
    if (!name || stage) return
    setError(null)
    setNote(null)
    setStage({ label: 'قراءة ملف المنطقة', fraction: 0.08 })
    try {
      // Relative URL so the packaged file:// desktop build resolves it too.
      const data = await loadRegion(`regions/${name}.json`)
      patchRegion({ attribution: data.attribution })
      setStage({ label: 'حساب الإحصاءات', fraction: 0.25 })
      setStats(describeRegion(data))

      if (!engineReady) throw new Error('المحرك لم يجهز بعد — انتظر اكتمال تحميل المشهد ثم أعد المحاولة')
      // Feature-detect on the object, then call THROUGH it. Pulling the method
      // out into a variable and calling that detaches it from the Sim instance,
      // so `this` is undefined inside and the first field it touches throws.
      const sim = (window as SimWindow).sim
      if (!sim?.loadRegion) throw new Error('بناء المناطق غير متاح في هذه النسخة من المحرك')

      setStage({ label: 'بناء التضاريس والطرق والمباني', fraction: 0.3 })
      let reported = false
      await sim.loadRegion(data, palette, {
        buildings,
        // The engine names each stage as it reaches it. Only if it says nothing
        // at all does the bar fall back to easing.
        onStage: (label, fraction) => {
          if (!reported) {
            reported = true
            stopCreep()
          }
          setStage({ label, fraction: 0.3 + fraction * 0.7 })
        },
      })
      if (!reported) startCreep()
      // Replace the figures read from the file with what the engine actually
      // built. Two of them differ: the file knows one surveyed building where
      // thousands now stand, and its steepest gradient is measured on the raw
      // satellite grid rather than on the graded road the player drives.
      const info = sim.regionInfo?.()
      if (info) {
        setStats(info.stats)
        setPlaced(info.buildings)
        setActive(info.surfaces)
      }
      patchRegion({ name, loaded: true, buildings, paletteJson: serialisePalette(palette) })
      setNote('تم بناء المنطقة داخل المشهد')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فشل تحميل المنطقة')
    } finally {
      stopCreep()
      setStage(null)
    }
  }

  /** Back to the procedural mud valley the simulator ships with. */
  async function unload() {
    if (stage || !region.loaded) return
    // Called through `sim`, never as a detached reference — see load().
    const sim = (window as SimWindow).sim
    if (!sim?.unloadRegion) {
      setError('العودة إلى الوادي غير متاحة في هذه النسخة من المحرك')
      return
    }
    setError(null)
    setNote(null)
    setStage({ label: 'العودة إلى الوادي الافتراضي', fraction: 0.4 })
    startCreep()
    try {
      await sim.unloadRegion()
      patchRegion({ loaded: false, attribution: null })
      setStats(null)
      setPlaced(null)
      setActive(null)
      setNote('تمت العودة إلى الوادي الافتراضي')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فشلت العودة إلى الوادي')
    } finally {
      stopCreep()
      setStage(null)
    }
  }

  /** Colour and roughness edits reach the scene on the spot — no rebuild needed. */
  function applyLive(next: Palette) {
    setPalette(next)
    // Survives the panel being unmounted by a tab switch.
    patchRegion({ paletteJson: serialisePalette(next) })
    if (!engineReady) return
    try {
      ;(window as SimWindow).sim?.applyRegionPalette?.(next)
    } catch (err) {
      console.warn('[ui] applyRegionPalette failed', err)
    }
  }

  function setStyle(key: SurfaceKey, patch: Partial<SurfaceStyle>) {
    const next = clonePalette(palette)
    next[key] = { ...palette[key], ...patch }
    applyLive(next)
  }

  function attachFile(key: SurfaceKey, file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setStyle(key, { textureUrl: reader.result })
      setPicking(null)
    }
    reader.onerror = () => setError('تعذّرت قراءة ملف الصورة')
    reader.readAsDataURL(file)
  }

  function exportPalette() {
    const text = serialisePalette(palette)
    setShare(text)
    setNote('تم تصدير الألوان — انسخ النص وشاركه')
    // Best effort: clipboard access is denied in some embedded contexts.
    void navigator.clipboard?.writeText(text).catch(() => undefined)
  }

  function importPalette() {
    const parsed = parsePalette(share)
    if (!parsed) {
      setError('النص المُلصق ليس ملف ألوان صالحاً')
      return
    }
    setError(null)
    setNote('تم استيراد الألوان وتطبيقها')
    applyLive(parsed)
  }

  const busy = stage !== null

  return (
    <Panel
      title="منطقة واقعية"
      className="min-w-0"
      bodyClassName="min-h-0 overflow-y-auto p-4"
      actions={
        <button
          type="button"
          title="إعادة الألوان الافتراضية"
          onClick={() => applyLive(clonePalette(DEFAULT_PALETTE))}
          className="grid h-7 w-7 place-content-center rounded-md text-mist-400 transition-colors hover:bg-ink-800 hover:text-mist-200"
        >
          <IconReset className="h-4 w-4" />
        </button>
      }
    >
      <div className="flex items-center gap-3">
        <select
          className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-[12px] text-mist-200 outline-none focus:border-brand-500"
          value={name}
          aria-label="المنطقة"
          disabled={names.length === 0}
          onChange={(e) => setName(e.target.value)}
        >
          {names.length === 0 && <option value="">لا توجد مناطق</option>}
          {names.map((n) => (
            <option key={n} value={n}>
              {REGION_LABEL[n] ?? n}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={load}
          disabled={busy || !name}
          className="flex shrink-0 items-center gap-2 rounded-lg bg-brand-500 px-3 py-2 text-[12px] font-medium text-white transition-colors hover:bg-brand-400 disabled:opacity-40"
        >
          <IconMountain className="h-4 w-4" />
          {busy ? 'جارٍ التحميل…' : region.loaded ? 'إعادة البناء' : 'تحميل المنطقة'}
        </button>
        {region.loaded && (
          <button
            type="button"
            onClick={unload}
            disabled={busy}
            title="العودة إلى الوادي الافتراضي"
            className="grid h-8 w-8 shrink-0 place-content-center rounded-lg border border-ink-600 text-mist-400 transition-colors hover:bg-ink-800 hover:text-mist-200 disabled:opacity-40"
          >
            <IconClose className="h-4 w-4" />
          </button>
        )}
      </div>

      <Toggle
        label="توليد المباني على قطع الأراضي"
        hint="خرائط OSM تحتوي مبنى واحداً فقط هنا"
        value={buildings}
        onChange={setBuildings}
      />

      {stage && (
        <div className="mt-2">
          <div className="mb-1 flex justify-between text-[11px] text-mist-400">
            <span>{stage.label}</span>
            <span className="tabular-nums">{Math.round(stage.fraction * 100)}٪</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
            <div
              className="h-full rounded-full bg-linear-to-l from-brand-500 to-accent-500 transition-[width] duration-200"
              style={{ width: `${Math.round(stage.fraction * 100)}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 whitespace-pre-line rounded-lg border border-bad-500/40 bg-bad-500/10 px-3 py-2 text-[11px] leading-5 text-bad-500">
          {error}
        </p>
      )}
      {note && !error && <p className="mt-2 text-[11px] text-good-500">{note}</p>}

      {stats && (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Stat label="المساحة" value={((stats.sizeM * stats.sizeM) / 1e6).toFixed(1)} unit="كم²" />
            <Stat label="عدد الطرق" value={String(stats.roadCount)} unit="طريق" />
            <Stat label="أطوال الطرق" value={stats.roadKm.toFixed(1)} unit="كم" />
            <Stat label="فارق الارتفاع" value={String(Math.round(stats.reliefM))} unit="م" />
            <Stat label="أشد انحدار" value={stats.steepestRoadGrade.toFixed(1)} unit="٪" />
            <Stat
              label="المباني"
              value={String(placed ?? stats.buildingCount)}
              unit={placed && placed > stats.buildingCount ? `مبنى · ${stats.buildingCount} مرسوم` : 'مبنى'}
            />
          </div>

          <details className="mt-2 rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2">
            <summary className="cursor-pointer text-[11px] text-mist-400">الملخص الكامل</summary>
            <p className="mt-2 whitespace-pre-line text-[11px] leading-5 text-mist-300">
              {regionSummaryArabic(stats)}
            </p>
          </details>
        </>
      )}

      <h3 className="mt-4 mb-2 text-[12px] font-medium text-mist-300">ألوان الأسطح</h3>
      <div className="space-y-1.5">
        {KEYS.map((key) => (
          <SurfaceRow
            key={key}
            style={palette[key]}
            inactive={active !== null && !active.includes(key)}
            open={picking === key}
            library={library}
            onTogglePicker={() => setPicking(picking === key ? null : key)}
            onColor={(color) => setStyle(key, { color })}
            onRoughness={(roughness) => setStyle(key, { roughness })}
            onTile={(tileMetres) => setStyle(key, { tileMetres })}
            onTexture={(textureUrl) => {
              setStyle(key, { textureUrl })
              setPicking(null)
            }}
            onFile={(file) => attachFile(key, file)}
          />
        ))}
      </div>

      <BrushSection library={library} />

      <h3 className="mt-4 mb-2 text-[12px] font-medium text-mist-300">حفظ ومشاركة الألوان</h3>
      <textarea
        rows={4}
        dir="ltr"
        placeholder='{ "road:major": { … } }'
        className="w-full resize-y rounded-md border border-ink-600 bg-ink-800 px-2.5 py-2 font-mono text-[10px] leading-4 text-mist-300 outline-none focus:border-brand-500"
        value={share}
        aria-label="ألوان المنطقة بصيغة JSON"
        onChange={(e) => setShare(e.target.value)}
      />
      <div className="mt-1.5 flex gap-2">
        <button
          type="button"
          onClick={exportPalette}
          className="flex-1 rounded-lg bg-ink-700 px-3 py-2 text-[12px] text-mist-200 transition-colors hover:bg-ink-600"
        >
          تصدير ونسخ
        </button>
        <button
          type="button"
          onClick={importPalette}
          disabled={share.trim().length === 0}
          className="flex-1 rounded-lg bg-ink-700 px-3 py-2 text-[12px] text-mist-200 transition-colors hover:bg-ink-600 disabled:opacity-40"
        >
          استيراد وتطبيق
        </button>
      </div>

      {/* ODbL obliges us to credit the source wherever the data is shown. */}
      <p className="mt-3 border-t border-ink-700 pt-2 text-[10px] leading-4 text-mist-400" dir="auto">
        {attribution ?? FALLBACK_ATTRIBUTION}
      </p>
    </Panel>
  )
}

type BrushMode = 'off' | 'decal' | 'model'

/**
 * The brush. Choose an image (a door, a window, grass) or a 3D model, set its
 * size, then click on the scene to stamp it — on the ground or on a wall.
 *
 * The engine owns the placing; this only configures it and reports the count.
 * A brush left on would keep painting on every click, so switching away from
 * this section is the user's job — the big "توقّف" makes that one tap.
 */
function BrushSection({ library }: { library: { id: string; url: string }[] }) {
  const [mode, setMode] = useState<BrushMode>('off')
  const [url, setUrl] = useState<string | null>(null)
  const [sizeM, setSizeM] = useState(2)
  const [rotationDeg, setRotationDeg] = useState(0)
  const [count, setCount] = useState(0)

  function push(next: { mode?: BrushMode; url?: string | null; sizeM?: number; rotationDeg?: number }) {
    simApi()?.setBrush?.(next)
  }

  function choose(m: BrushMode) {
    setMode(m)
    // Switching to a mode with no asset yet keeps the brush off until one is
    // picked, so an accidental click paints nothing.
    push({ mode: m === 'off' ? 'off' : url ? m : 'off', url, sizeM, rotationDeg })
  }

  function pickImage(u: string | null) {
    setUrl(u)
    push({ mode: u ? mode : 'off', url: u, sizeM, rotationDeg })
  }

  function onFile(file: File | undefined, expect: 'image' | 'model') {
    if (!file) return
    // A model is a binary GLB — an object URL avoids base64-inflating megabytes.
    if (expect === 'model') {
      pickImage(URL.createObjectURL(file))
      return
    }
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' && pickImage(reader.result)
    reader.readAsDataURL(file)
  }

  const armed = mode !== 'off' && !!url

  return (
    <>
      <h3 className="mt-4 mb-2 flex items-center gap-2 text-[12px] font-medium text-mist-300">
        الفرشاة — ارسم على الأرض والمباني
        {armed && <span className="rounded bg-brand-500/20 px-1.5 py-0.5 text-[10px] text-brand-300">مفعّلة</span>}
      </h3>

      <div className="flex gap-1 rounded-lg border border-ink-700 bg-ink-850 p-1">
        {(['off', 'decal', 'model'] as BrushMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => choose(m)}
            className={`flex-1 rounded-md px-2 py-1.5 text-[11px] transition-colors ${
              mode === m ? 'bg-brand-500/15 font-medium text-brand-400' : 'text-mist-400 hover:bg-ink-800'
            }`}
          >
            {m === 'off' ? 'توقّف' : m === 'decal' ? 'صورة' : 'مجسّم 3D'}
          </button>
        ))}
      </div>

      {mode !== 'off' && (
        <div className="mt-2 space-y-2 rounded-lg border border-ink-700 bg-ink-900/60 p-2">
          {mode === 'decal' ? (
            <>
              {library.length > 0 && (
                <div className="grid grid-cols-6 gap-1.5">
                  {library.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => pickImage(t.url)}
                      className={`relative aspect-square overflow-hidden rounded-md border transition-colors ${
                        t.url === url ? 'border-brand-500' : 'border-ink-600 hover:border-ink-500'
                      }`}
                    >
                      <img src={t.url} alt="" className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
              <label className="block cursor-pointer rounded-md bg-ink-700 px-2 py-1.5 text-center text-[11px] text-mist-200 transition-colors hover:bg-ink-600">
                اختيار صورة (باب، شباك، أعشاب…)
                <input type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0], 'image')} />
              </label>
              {url && <img src={url} alt="" className="h-12 w-full rounded object-contain" />}
            </>
          ) : (
            <>
              <label className="block cursor-pointer rounded-md bg-ink-700 px-2 py-1.5 text-center text-[11px] text-mist-200 transition-colors hover:bg-ink-600">
                اختيار ملف مجسّم (.glb)
                <input type="file" accept=".glb,model/gltf-binary" className="hidden" onChange={(e) => onFile(e.target.files?.[0], 'model')} />
              </label>
              {url && <p className="truncate text-[10px] text-mist-400" dir="ltr">{url.slice(0, 48)}</p>}
            </>
          )}

          <BrushSlider
            label="الحجم"
            value={sizeM}
            min={0.2}
            max={mode === 'model' ? 30 : 12}
            log
            display={sizeM < 1 ? `${Math.round(sizeM * 100)}سم` : `${sizeM.toFixed(1)}م`}
            onChange={(v) => {
              setSizeM(v)
              push({ mode: armed ? mode : 'off', url, sizeM: v, rotationDeg })
            }}
          />
          <BrushSlider
            label="دوران"
            value={rotationDeg}
            min={0}
            max={360}
            display={`${Math.round(rotationDeg)}°`}
            onChange={(v) => {
              setRotationDeg(v)
              push({ mode: armed ? mode : 'off', url, sizeM, rotationDeg: v })
            }}
          />

          <p className="text-[10px] leading-4 text-mist-400">
            {armed
              ? 'انقر على الأرض أو على جدار مبنى لوضع النسخة. اسحب لتدوير الكاميرا.'
              : 'اختر صورة أو مجسّماً أولاً.'}
          </p>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setCount(simApi()?.brushUndo?.() ?? 0)}
              disabled={count === 0}
              className="flex-1 rounded-md bg-ink-700 px-2 py-1.5 text-[11px] text-mist-200 transition-colors hover:bg-ink-600 disabled:opacity-40"
            >
              تراجع
            </button>
            <button
              type="button"
              onClick={() => {
                simApi()?.brushClear?.()
                setCount(0)
              }}
              disabled={count === 0}
              className="flex-1 rounded-md bg-ink-700 px-2 py-1.5 text-[11px] text-mist-200 transition-colors hover:bg-ink-600 disabled:opacity-40"
            >
              مسح الكل ({count})
            </button>
          </div>

          {/* The engine reports the true count after each stamp; a click may miss
              (the sky) and place nothing, so poll on a short timer while armed. */}
          {armed && <CountPoller onCount={setCount} />}
        </div>
      )}
    </>
  )
}

/**
 * A stamp happens on a canvas click, which React never sees, and a click can
 * miss and place nothing. So the true count lives in the engine and this reads
 * it back a couple of times a second while the brush is armed.
 */
function CountPoller({ onCount }: { onCount: (n: number) => void }) {
  useEffect(() => {
    const id = window.setInterval(() => {
      const c = simApi()?.brushCount?.()
      if (typeof c === 'number') onCount(c)
    }, 500)
    return () => window.clearInterval(id)
  }, [onCount])
  return null
}

function BrushSlider({
  label,
  value,
  min,
  max,
  display,
  log = false,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  display: string
  log?: boolean
  onChange: (v: number) => void
}) {
  const toSlider = (v: number) => (log ? Math.log(v) : v)
  const lo = toSlider(min)
  const hi = toSlider(max)
  const pos = value <= min ? 0 : value >= max ? 1 : (toSlider(value) - lo) / (hi - lo)
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-[11px] text-mist-400">{label}</span>
      <input
        type="range"
        min={lo}
        max={hi}
        step={(hi - lo) / 200}
        value={toSlider(value)}
        aria-label={label}
        onChange={(e) => onChange(log ? Math.exp(Number(e.target.value)) : Number(e.target.value))}
        className="h-4 min-w-0 flex-1"
        style={{
          ['--track' as string]: `linear-gradient(to right, var(--color-brand-500) ${pos * 100}%, var(--color-ink-600) ${pos * 100}%)`,
        }}
      />
      <span className="w-10 shrink-0 text-end text-[11px] tabular-nums text-mist-300">{display}</span>
    </div>
  )
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900/60 px-2.5 py-2">
      <div className="text-[10px] text-mist-400">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-[18px] font-semibold tabular-nums text-mist-200">{value}</span>
        <span className="text-[10px] text-mist-400">{unit}</span>
      </div>
    </div>
  )
}

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className="mt-2 flex w-full items-center gap-3 rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-start transition-colors hover:border-ink-600"
    >
      <span
        className={`relative h-4 w-8 shrink-0 rounded-full transition-colors ${
          value ? 'bg-brand-500' : 'bg-ink-600'
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-[inset-inline-start] ${
            value ? 'start-4.5' : 'start-0.5'
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[12px] text-mist-200">{label}</span>
        <span className="block text-[10px] text-mist-400">{hint}</span>
      </span>
    </button>
  )
}

function SurfaceRow({
  style,
  inactive,
  open,
  library,
  onTogglePicker,
  onColor,
  onRoughness,
  onTile,
  onTexture,
  onFile,
}: {
  style: SurfaceStyle
  /** This region contains nothing of this surface, so editing it does nothing. */
  inactive: boolean
  open: boolean
  library: { id: string; url: string }[]
  onTogglePicker: () => void
  onColor: (v: string) => void
  onRoughness: (v: number) => void
  onTile: (metres: number) => void
  onTexture: (url: string | null) => void
  onFile: (file: File | undefined) => void
}) {
  const pct = style.roughness * 100
  return (
    <div
      className={`rounded-lg border border-ink-700 bg-ink-900/60 p-2 ${inactive ? 'opacity-45' : ''}`}
      title={inactive ? 'لا يوجد من هذا السطح شيء في هذه المنطقة' : undefined}
    >
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={style.color}
          aria-label={`لون ${style.label}`}
          onChange={(e) => onColor(e.target.value)}
          className="h-7 w-7 shrink-0 cursor-pointer rounded-md border border-ink-600 bg-ink-800 p-0.5"
        />
        <span className="min-w-0 flex-1 truncate text-[12px] text-mist-300">
          {style.label}
          {inactive && <span className="ms-1.5 text-[10px] text-mist-500">لا يوجد هنا</span>}
        </span>
        <button
          type="button"
          onClick={onTogglePicker}
          title="إرفاق نسيج"
          className={`grid h-7 w-7 place-content-center overflow-hidden rounded-md border transition-colors ${
            open ? 'border-brand-500 text-brand-400' : 'border-ink-600 text-mist-400 hover:text-mist-200'
          }`}
        >
          {style.textureUrl ? (
            <img src={style.textureUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <IconAssets className="h-4 w-4" />
          )}
        </button>
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        <span className="w-10 shrink-0 text-[11px] text-mist-400">خشونة</span>
        <input
          type="range"
          min={0.04}
          max={1}
          step={0.01}
          value={style.roughness}
          aria-label={`خشونة ${style.label}`}
          onChange={(e) => onRoughness(Number(e.target.value))}
          className="h-4 min-w-0 flex-1"
          style={{
            ['--track' as string]: `linear-gradient(to right, var(--color-brand-500) ${pct}%, var(--color-ink-600) ${pct}%)`,
          }}
        />
        <span className="w-8 shrink-0 text-end text-[11px] tabular-nums text-mist-300">
          {style.roughness.toFixed(2)}
        </span>
      </div>

      {style.textureUrl && (
        <div className="mt-1.5 flex items-center gap-2">
          <span className="w-10 shrink-0 text-[11px] text-mist-400">الحجم</span>
          <input
            type="range"
            // Metres per repeat. Log scale: one repeat every 20 cm (tiny) up to
            // every 30 m (huge). Small = the image is smaller on the ground.
            min={Math.log(0.2)}
            max={Math.log(30)}
            step={0.01}
            value={Math.log(style.tileMetres)}
            aria-label={`حجم نسيج ${style.label}`}
            onChange={(e) => onTile(Math.exp(Number(e.target.value)))}
            className="h-4 min-w-0 flex-1"
            style={{
              ['--track' as string]: `linear-gradient(to right, var(--color-brand-500) ${
                ((Math.log(style.tileMetres) - Math.log(0.2)) / (Math.log(30) - Math.log(0.2))) * 100
              }%, var(--color-ink-600) ${
                ((Math.log(style.tileMetres) - Math.log(0.2)) / (Math.log(30) - Math.log(0.2))) * 100
              }%)`,
            }}
          />
          <span className="w-10 shrink-0 text-end text-[11px] tabular-nums text-mist-300">
            {style.tileMetres < 1 ? `${Math.round(style.tileMetres * 100)}سم` : `${style.tileMetres.toFixed(1)}م`}
          </span>
        </div>
      )}

      {open && (
        <div className="mt-2 border-t border-ink-700 pt-2">
          {library.length === 0 ? (
            <p className="text-[10px] text-mist-400">
              لا توجد أنسجة مولّدة بعد — أنشئ واحداً في استوديو الصور أو اختر ملفاً
            </p>
          ) : (
            <div className="grid grid-cols-6 gap-1.5">
              {library.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onTexture(t.url)}
                  className={`relative aspect-square overflow-hidden rounded-md border transition-colors ${
                    t.url === style.textureUrl ? 'border-brand-500' : 'border-ink-600 hover:border-ink-500'
                  }`}
                >
                  <img src={t.url} alt="" className="h-full w-full object-cover" />
                  {t.url === style.textureUrl && (
                    <span className="absolute top-0.5 start-0.5 grid h-3.5 w-3.5 place-content-center rounded-full bg-brand-500 text-white">
                      <IconCheck className="h-2.5 w-2.5" />
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          <div className="mt-2 flex items-center gap-2">
            <label className="flex-1 cursor-pointer rounded-md bg-ink-700 px-2 py-1.5 text-center text-[11px] text-mist-200 transition-colors hover:bg-ink-600">
              اختيار ملف صورة
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
            </label>
            <button
              type="button"
              onClick={() => onTexture(null)}
              disabled={!style.textureUrl}
              title="إزالة النسيج"
              className="grid h-7 w-7 shrink-0 place-content-center rounded-md bg-ink-700 text-mist-400 transition-colors hover:bg-ink-600 hover:text-mist-200 disabled:opacity-40"
            >
              <IconClose className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
