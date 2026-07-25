import { useEffect, useRef, useState } from 'react'
import { useSim } from '../store/simStore'
import { Panel } from './Chrome'
import { IconAssets, IconCheck, IconSparkles } from './icons'
import { defaultsForKind, processPhoto, processPhotoAll, type MaterialResult, type ProgressUpdate } from '../engine/photo/pipeline'
import { segment } from '../engine/photo/segment'
import { autoDetectQuad } from '../engine/photo/rectify'
import {
  type MaterialKind,
  type PbrMaps,
  type PhotoRegion,
  type ProcessOptions,
  type Quad,
  type RGBAImage,
  DEFAULT_PROCESS,
  loadImage,
  toDataURL,
} from '../engine/photo/types'

type SimWindow = Window & {
  sim?: {
    applyPartTexture(id: string, url: string): number
    /** Optional: only present once the engine ships ground re-texturing. */
    applyGroundTexture?(url: string, tileMetres: number): number
  }
}

/** The kinds worth offering by hand. `fabric`/`unknown` exist in the pipeline for
 *  the auto-segmenter's benefit, but nobody photographs a yard to get upholstery. */
const KINDS: { kind: MaterialKind; label: string }[] = [
  { kind: 'wall', label: 'جدار' },
  { kind: 'door', label: 'باب' },
  { kind: 'window', label: 'شباك' },
  { kind: 'ground', label: 'أرض' },
  { kind: 'rock', label: 'صخر' },
  { kind: 'wood', label: 'خشب' },
  { kind: 'metal', label: 'معدن' },
]

const SIZES: ProcessOptions['size'][] = [512, 1024, 2048, 4096]

const MAP_LABELS: [keyof PbrMaps, string][] = [
  ['albedo', 'اللون'],
  ['normal', 'النتوء'],
  ['roughness', 'الخشونة'],
  ['ao', 'الانحجاب'],
  ['height', 'الارتفاع'],
]

const CORNER_NAMES = ['أعلى يسار', 'أعلى يمين', 'أسفل يمين', 'أسفل يسار']

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function kindLabel(kind: MaterialKind): string {
  return KINDS.find((k) => k.kind === kind)?.label ?? 'سطح'
}

/** Percent coordinates for the overlay, which is drawn in a 0..100 viewBox so the
 *  quad follows the image however the browser scales it. */
function pct(q: Quad, w: number, h: number): string {
  return q.map((p) => `${(p.x / w) * 100},${(p.y / h) * 100}`).join(' ')
}

// ----------------------------------------------------------------- quad editor

/**
 * The photo with four draggable corners.
 *
 * The container is inline-block so it shrinks to exactly the rendered image —
 * that makes its bounding rect the coordinate space, and screen → source-pixel
 * mapping stays a single multiply with no letterboxing to compensate for.
 */
function QuadEditor({
  src,
  image,
  quad,
  regions,
  onChange,
}: {
  src: string
  image: RGBAImage
  quad: Quad
  regions: PhotoRegion[]
  onChange: (q: Quad) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)

  function moveCorner(i: number, clientX: number, clientY: number) {
    const box = boxRef.current
    if (!box) return
    const r = box.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return
    const x = clamp(((clientX - r.left) / r.width) * image.width, 0, image.width - 1)
    const y = clamp(((clientY - r.top) / r.height) * image.height, 0, image.height - 1)
    onChange(quad.map((p, k) => (k === i ? { x, y } : p)) as Quad)
  }

  return (
    <div className="flex justify-center rounded-lg border border-ink-700 bg-ink-900 p-2">
      <div ref={boxRef} className="relative inline-block touch-none">
        <img
          src={src}
          alt="الصورة المصدر"
          draggable={false}
          className="block max-h-[320px] max-w-full rounded-md select-none"
        />

        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {regions.map((r) => (
            <polygon
              key={r.id}
              points={pct(r.quad, image.width, image.height)}
              fill="none"
              stroke="var(--color-mist-400)"
              strokeWidth={1}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <polygon
            points={pct(quad, image.width, image.height)}
            fill="var(--color-brand-500)"
            fillOpacity={0.14}
            stroke="var(--color-brand-400)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {quad.map((p, i) => (
          <button
            key={i}
            type="button"
            title={CORNER_NAMES[i]}
            aria-label={CORNER_NAMES[i]}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              setDragging(i)
            }}
            onPointerMove={(e) => {
              if (dragging === i) moveCorner(i, e.clientX, e.clientY)
            }}
            onPointerUp={(e) => {
              e.currentTarget.releasePointerCapture(e.pointerId)
              setDragging(null)
            }}
            onKeyDown={(e) => {
              // Keyboard nudge, because a 3-pixel correction is hopeless by hand.
              const step = e.shiftKey ? 20 : 3
              const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
              const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
              if (!dx && !dy) return
              e.preventDefault()
              const r = boxRef.current?.getBoundingClientRect()
              const scale = r && r.width > 0 ? image.width / r.width : 1
              onChange(
                quad.map((q, k) =>
                  k === i
                    ? {
                        x: clamp(q.x + dx * scale, 0, image.width - 1),
                        y: clamp(q.y + dy * scale, 0, image.height - 1),
                      }
                    : q,
                ) as Quad,
              )
            }}
            style={{
              left: `${(p.x / image.width) * 100}%`,
              top: `${(p.y / image.height) * 100}%`,
            }}
            className={`absolute grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none place-content-center rounded-full border-2 bg-ink-950/60 transition-colors ${
              dragging === i ? 'border-brand-400 bg-brand-500/40' : 'border-brand-500 hover:border-brand-400'
            }`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-brand-400" />
          </button>
        ))}
      </div>
    </div>
  )
}

// -------------------------------------------------------------- result display

function ResultCard({
  result,
  active,
  onApplyPart,
  onApplyGround,
  partLabel,
}: {
  result: MaterialResult
  active: boolean
  onApplyPart: () => void
  onApplyGround: () => void
  partLabel: string
}) {
  const seam = Math.round(result.tilingScore * 100)
  const seamTone = seam >= 60 ? 'text-good-500' : seam >= 40 ? 'text-warn-500' : 'text-bad-500'

  return (
    <div
      className={`rounded-lg border p-3 ${active ? 'border-brand-500 bg-brand-500/5' : 'border-ink-700'}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate text-[12px] font-medium text-mist-200">
          {result.label} · {kindLabel(result.kind)}
        </span>
        <span className="shrink-0 text-[11px] text-mist-400">
          جودة التكرار <span className={`tabular-nums ${seamTone}`}>{seam}٪</span> · تبليط{' '}
          <span className="tabular-nums">{result.tileMetres}</span> م
        </span>
      </div>

      <div className="grid grid-cols-5 gap-2">
        {MAP_LABELS.map(([key, label]) => (
          <figure key={key}>
            <div className="overflow-hidden rounded-md border border-ink-600 bg-ink-900">
              <img src={result.previews[key]} alt={label} className="aspect-square w-full object-cover" />
            </div>
            <figcaption className="mt-1 truncate text-center text-[10px] text-mist-400">{label}</figcaption>
          </figure>
        ))}
      </div>

      {result.warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {result.warnings.map((w, i) => (
            <li key={i} className="text-[11px] leading-4 text-warn-500">
              • {w}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onApplyPart}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-ink-700 px-2 py-1.5 text-[11px] text-mist-200 transition-colors hover:bg-ink-600"
        >
          {active && <IconCheck className="h-3.5 w-3.5" />}
          تطبيق على {partLabel}
        </button>
        <button
          type="button"
          onClick={onApplyGround}
          className="flex-1 rounded-md bg-ink-700 px-2 py-1.5 text-[11px] text-mist-200 transition-colors hover:bg-ink-600"
        >
          تطبيق على الأرض
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------- panel

/**
 * Photo → game material. The user photographs a wall, marks its four corners,
 * and the pipeline hands back a full PBR set that can be painted onto the truck
 * or the terrain without leaving the dashboard.
 */
export function PhotoStudio() {
  const parts = useSim((s) => s.parts)
  const selectedPartId = useSim((s) => s.selectedPartId)
  const engineReady = useSim((s) => s.engineReady)

  const [photo, setPhoto] = useState<RGBAImage | null>(null)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [quad, setQuad] = useState<Quad | null>(null)
  const [kind, setKind] = useState<MaterialKind>('wall')
  const [size, setSize] = useState<ProcessOptions['size']>(DEFAULT_PROCESS.size)
  const [widthM, setWidthM] = useState(DEFAULT_PROCESS.realWorldWidthM)
  const [tileable, setTileable] = useState(DEFAULT_PROCESS.tileable)
  const [regions, setRegions] = useState<PhotoRegion[]>([])
  const [results, setResults] = useState<MaterialResult[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [progress, setProgress] = useState<ProgressUpdate | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const partLabel = parts.find((p) => p.id === selectedPartId)?.label ?? 'الجزء'

  // The preview URL is ours to own: loadImage() makes and revokes its own. Kept
  // in a ref with empty deps because StrictMode's simulated unmount fires before
  // any photo exists — a [photoUrl] cleanup would revoke the live one in dev.
  const urlRef = useRef<string | null>(null)
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])

  async function openFile(file: File | undefined | null) {
    if (!file || busy) return
    setStatus(null)
    try {
      const img = await loadImage(file)
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = URL.createObjectURL(file)
      setPhoto(img)
      setPhotoUrl(urlRef.current)
      setQuad(autoDetectQuad(img))
      setRegions([])
      setResults([])
      setActiveId(null)
      setStatus(`تم تحميل الصورة (${img.width}×${img.height}) — اسحب الزوايا الأربع لتحديد السطح`)
    } catch (err) {
      setStatus(err instanceof Error ? `تعذّر فتح الصورة: ${err.message}` : 'تعذّر فتح الصورة')
    }
  }

  function chooseKind(k: MaterialKind) {
    setKind(k)
    const d = defaultsForKind(k)
    setTileable(d.tileable ?? DEFAULT_PROCESS.tileable)
    setWidthM(d.realWorldWidthM ?? DEFAULT_PROCESS.realWorldWidthM)
  }

  async function runSingle() {
    if (!photo || !quad || busy) return
    setBusy(true)
    setStatus(null)
    setProgress({ stage: 'التحضير', fraction: 0 })
    try {
      const region: PhotoRegion = { id: `manual-${Date.now()}`, label: kindLabel(kind), quad, kind }
      const r = await processPhoto(
        photo,
        region,
        { ...defaultsForKind(kind), size, tileable, realWorldWidthM: widthM },
        setProgress,
      )
      setResults([r])
      setStatus('اكتملت المعالجة')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'فشلت المعالجة')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  async function runSegment() {
    if (!photo || busy) return
    setBusy(true)
    setStatus(null)
    try {
      // segment() is synchronous and takes a beat on a 12MP photo; yield once so
      // the disabled/busy state actually paints before the main thread locks up.
      await new Promise((r) => setTimeout(r, 0))
      const found = segment(photo)
      setRegions(found)
      setStatus(
        found.length > 0
          ? `عُثر على ${found.length} منطقة — اختر واحدة أو عالجها كلها`
          : 'لم يُعثر على مناطق واضحة، حدّد السطح يدوياً',
      )
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'فشل التقسيم التلقائي')
    } finally {
      setBusy(false)
    }
  }

  async function runAll() {
    if (!photo || busy || regions.length === 0) return
    setBusy(true)
    setStatus(null)
    setProgress({ stage: 'التحضير', fraction: 0 })
    try {
      // Only the size is forced: each detected region carries its own kind, and
      // overriding tiling or scale here would flatten that back to one guess.
      const list = await processPhotoAll(photo, regions, { size }, setProgress)
      setResults(list)
      setStatus(`اكتملت معالجة ${list.length} منطقة`)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'فشلت المعالجة')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  /** Full-resolution albedo — the previews in `result.previews` are capped at
   *  512 px for the thumbnails and would ship a blurry texture into the scene. */
  function applyToPart(r: MaterialResult) {
    if (!engineReady) {
      setStatus('المحرك لم يجهز بعد — انتظر اكتمال تحميل المشهد')
      return
    }
    try {
      const applied = (window as SimWindow).sim?.applyPartTexture(selectedPartId, toDataURL(r.maps.albedo)) ?? 0
      setActiveId(r.id)
      setStatus(applied > 0 ? `تم تطبيق المادة على ${applied} شبكة` : 'لم يُعثر على شبكات مطابقة لهذا الجزء')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'تعذّر التطبيق على المركبة')
    }
  }

  function applyToGround(r: MaterialResult) {
    if (!engineReady) {
      setStatus('المحرك لم يجهز بعد — انتظر اكتمال تحميل المشهد')
      return
    }
    const apply = (window as SimWindow).sim?.applyGroundTexture
    if (!apply) {
      setStatus('تطبيق مادة الأرض غير متاح في هذه النسخة من المحرك')
      return
    }
    try {
      apply(toDataURL(r.maps.albedo), r.tileMetres)
      setActiveId(r.id)
      setStatus('تم تطبيق المادة على الأرض')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'تعذّر التطبيق على الأرض')
    }
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-col"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        void openFile(e.dataTransfer.files?.[0])
      }}
    >
      <Panel
        title="استوديو الصور — من صورة إلى مادة"
        className={`min-w-0 flex-1 ${dragOver ? 'border-brand-500' : ''}`}
        bodyClassName="space-y-3 overflow-y-auto p-4"
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            void openFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />

        {photo && photoUrl && quad ? (
          <QuadEditor src={photoUrl} image={photo} quad={quad} regions={regions} onChange={setQuad} />
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="w-full rounded-lg border border-dashed border-ink-600 px-3 py-10 text-center text-[12px] text-mist-400 transition-colors hover:border-brand-500 hover:text-mist-300"
          >
            اسحب صورة من جوالك إلى هنا، أو اضغط للاختيار
          </button>
        )}

        <div className="flex flex-wrap gap-1.5">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              onClick={() => chooseKind(k.kind)}
              aria-pressed={k.kind === kind}
              className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
                k.kind === kind
                  ? 'border-brand-500 bg-brand-500/15 text-brand-400'
                  : 'border-ink-600 text-mist-400 hover:border-ink-500 hover:text-mist-200'
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 items-end gap-2">
          <label className="block">
            <span className="mb-1 block text-[11px] text-mist-400">حجم الإخراج</span>
            <select
              className="w-full rounded-md border border-ink-600 bg-ink-800 px-2 py-1.5 text-[12px] text-mist-200 outline-none focus:border-brand-500"
              value={size}
              onChange={(e) => setSize(Number(e.target.value) as ProcessOptions['size'])}
            >
              {SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}×{s}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] text-mist-400">العرض الحقيقي (م)</span>
            <input
              type="number"
              min={0.1}
              max={50}
              step={0.1}
              value={widthM}
              onChange={(e) => setWidthM(clamp(Number(e.target.value) || 0.1, 0.1, 50))}
              className="w-full rounded-md border border-ink-600 bg-ink-800 px-2 py-1.5 text-[12px] tabular-nums text-mist-200 outline-none focus:border-brand-500"
            />
          </label>

          <label className="flex cursor-pointer items-center gap-2 pb-1.5 text-[12px] text-mist-300">
            <input
              type="checkbox"
              checked={tileable}
              onChange={(e) => setTileable(e.target.checked)}
              className="h-3.5 w-3.5 accent-brand-500"
            />
            قابل للتبليط
          </label>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={runSingle}
            disabled={busy || !photo}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-linear-to-l from-brand-500 to-accent-500 px-3 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <IconSparkles className="h-4 w-4" />
            {busy ? 'جارٍ العمل…' : 'معالجة الصورة'}
          </button>
          <button
            type="button"
            onClick={runSegment}
            disabled={busy || !photo}
            className="flex items-center justify-center gap-2 rounded-lg bg-ink-700 px-3 py-2.5 text-[12px] text-mist-200 transition-colors hover:bg-ink-600 disabled:opacity-50"
          >
            <IconAssets className="h-4 w-4" />
            تقسيم تلقائي
          </button>
          {photo && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="rounded-lg bg-ink-700 px-3 py-2.5 text-[12px] text-mist-200 transition-colors hover:bg-ink-600 disabled:opacity-50"
            >
              صورة أخرى
            </button>
          )}
        </div>

        {progress && (
          <div>
            <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-mist-400">
              <span className="truncate">{progress.stage}</span>
              <span className="shrink-0 tabular-nums">{Math.round(progress.fraction * 100)}٪</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
              <div
                className="h-full rounded-full bg-brand-500 transition-[width] duration-200"
                style={{ width: `${Math.round(progress.fraction * 100)}%` }}
              />
            </div>
          </div>
        )}

        {status && <p className="text-[11px] leading-4 text-mist-400">{status}</p>}

        {regions.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <h3 className="text-[12px] font-medium text-mist-300">المناطق المكتشفة</h3>
              <button
                type="button"
                onClick={runAll}
                disabled={busy}
                className="rounded-md bg-ink-700 px-2 py-1 text-[11px] text-mist-200 transition-colors hover:bg-ink-600 disabled:opacity-50"
              >
                معالجة كل المناطق
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {regions.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    setQuad(r.quad)
                    chooseKind(r.kind)
                  }}
                  className="rounded-md border border-ink-600 px-2 py-1 text-[11px] text-mist-400 transition-colors hover:border-brand-500 hover:text-mist-200"
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {results.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-[12px] font-medium text-mist-300">المواد الناتجة</h3>
            {results.map((r) => (
              <ResultCard
                key={r.id}
                result={r}
                active={r.id === activeId}
                partLabel={partLabel}
                onApplyPart={() => applyToPart(r)}
                onApplyGround={() => applyToGround(r)}
              />
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}
