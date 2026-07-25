import { useRef, useState } from 'react'
import { Panel } from './Chrome'
import { IconClose, IconMountain } from './icons'
import { loadImage, type RGBAImage } from '../engine/photo/types'
import { buildingFromPhotos, type FacadeInput } from '../engine/photo/buildingFromPhotos'
import { SIDES, type BuildingSide } from '../engine/photo/buildingSpec'

/**
 * Photos of a building's façades → a 3D building.
 *
 * Upload one photo (the front) or several (front/back/left/right), the AI reads
 * floors, windows, doors, roof and colours, code builds the mesh with the real
 * de-lit photos on the sides you shot and drawn façades on the rest, and the
 * brush is armed so you click to place copies. One façade is enough — the other
 * sides are inferred to match.
 */

const SIDE_LABEL: Record<BuildingSide, string> = {
  front: 'أمامية',
  back: 'خلفية',
  left: 'يسار',
  right: 'يمين',
}

interface Shot {
  id: string
  side: BuildingSide
  url: string
  image: RGBAImage
}

type SimWindow = Window & {
  sim?: {
    buildBuildingFromSpec?(
      spec: unknown,
      photos: (string | null)[],
    ): { widthM: number; depthM: number; floors: number }
    setBrush?(c: { mode?: 'off' | 'decal' | 'model'; url?: string | null }): void
  }
}

export function BuildingStudio() {
  const [shots, setShots] = useState<Shot[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [armed, setArmed] = useState<{ w: number; d: number; floors: number; ai: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  async function addFiles(files: FileList | null) {
    if (!files?.length) return
    setError(null)
    const next: Shot[] = []
    for (const file of Array.from(files).slice(0, 4 - shots.length)) {
      try {
        const image = await loadImage(file)
        // First upload is the front; the rest fill the remaining sides in order.
        const used = new Set([...shots, ...next].map((s) => s.side))
        const side = SIDES.find((x) => !used.has(x)) ?? 'front'
        next.push({ id: `s${seq.current++}`, side, url: URL.createObjectURL(file), image })
      } catch {
        setError('تعذّرت قراءة إحدى الصور')
      }
    }
    setShots((prev) => [...prev, ...next].slice(0, 4))
  }

  function setSide(id: string, side: BuildingSide) {
    // Sides are unique — if another shot already holds this side, swap them.
    setShots((prev) => {
      const holder = prev.find((s) => s.side === side && s.id !== id)
      const mine = prev.find((s) => s.id === id)
      return prev.map((s) => {
        if (s.id === id) return { ...s, side }
        if (holder && s.id === holder.id && mine) return { ...s, side: mine.side }
        return s
      })
    })
  }

  function remove(id: string) {
    setShots((prev) => prev.filter((s) => s.id !== id))
  }

  async function generate() {
    if (shots.length === 0 || busy) return
    const build = (window as SimWindow).sim?.buildBuildingFromSpec
    if (!build) {
      setError('توليد المباني غير متاح في هذه النسخة من المحرك')
      return
    }
    setBusy(true)
    setError(null)
    setStatus('يقرأ الواجهات ويبني المبنى…')
    try {
      const inputs: FacadeInput[] = shots.map((s) => ({ side: s.side, image: s.image }))
      const { spec, photos, source } = await buildingFromPhotos(inputs)
      const dims = build(spec, photos)
      setArmed({ w: dims.widthM, d: dims.depthM, floors: dims.floors, ai: source === 'ai' })
      setStatus(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فشل توليد المبنى')
    } finally {
      setBusy(false)
    }
  }

  function stop() {
    ;(window as SimWindow).sim?.setBrush?.({ mode: 'off' })
    setArmed(null)
  }

  return (
    <Panel title="مبنى من صور" className="min-w-0" bodyClassName="min-h-0 overflow-y-auto p-4">
      <p className="mb-3 text-[11px] leading-5 text-mist-400">
        ارفع صورة واجهة واحدة أو أكثر (أمامية/خلفية/جوانب)، والذكاء الصناعي يقرأها ويبني مبنى 3D —
        بواجهاتك الحقيقية على الجهات المصوّرة، وواجهات مولّدة على الباقي. من صورة وحدة يبني مبنى كامل.
      </p>

      <div className="space-y-2">
        {shots.map((s) => (
          <div key={s.id} className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900/60 p-2">
            <img src={s.url} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
            <select
              value={s.side}
              aria-label="الجهة"
              onChange={(e) => setSide(s.id, e.target.value as BuildingSide)}
              className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-800 px-2 py-1.5 text-[12px] text-mist-200 outline-none focus:border-brand-500"
            >
              {SIDES.map((x) => (
                <option key={x} value={x}>
                  {SIDE_LABEL[x]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => remove(s.id)}
              className="grid h-7 w-7 shrink-0 place-content-center rounded-md text-mist-400 hover:bg-ink-800 hover:text-mist-200"
            >
              <IconClose className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      {shots.length < 4 && (
        <label className="mt-2 block cursor-pointer rounded-lg bg-ink-700 px-3 py-2 text-center text-[12px] text-mist-200 transition-colors hover:bg-ink-600">
          {shots.length === 0 ? 'اختيار صور الواجهات' : 'إضافة واجهة أخرى'}
          <input
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => void addFiles(e.target.files)}
          />
        </label>
      )}

      <button
        type="button"
        onClick={generate}
        disabled={shots.length === 0 || busy}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-3 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-brand-400 disabled:opacity-40"
      >
        <IconMountain className="h-4 w-4" />
        {busy ? 'جارٍ البناء…' : 'ابنِ المبنى 3D'}
      </button>

      {status && <p className="mt-2 text-[11px] text-mist-400">{status}</p>}
      {error && <p className="mt-2 text-[11px] text-bad-500">{error}</p>}

      {armed && (
        <div className="mt-3 rounded-lg border border-brand-500/40 bg-brand-500/10 p-3">
          <p className="text-[12px] font-medium text-brand-300">المبنى جاهز — انقر على الأرض لوضعه</p>
          <p className="mt-1 text-[11px] text-mist-300">
            {Math.round(armed.w)}م × {Math.round(armed.d)}م · {armed.floors} طوابق ·{' '}
            {armed.ai ? 'قراءة بالذكاء الصناعي' : 'قراءة محلّية (بدون مفتاح)'}
          </p>
          <p className="mt-1 text-[10px] leading-4 text-mist-400">
            كل نقرة تضع نسخة. للتحكّم بالحجم والدوران استخدم قسم «الفرشاة». اضغط «توقّف» للانتهاء.
          </p>
          <button
            type="button"
            onClick={stop}
            className="mt-2 w-full rounded-md bg-ink-700 px-2 py-1.5 text-[11px] text-mist-200 transition-colors hover:bg-ink-600"
          >
            توقّف
          </button>
        </div>
      )}

      <p className="mt-3 border-t border-ink-700 pt-2 text-[10px] leading-4 text-mist-400">
        القراءة بالذكاء الصناعي تحتاج مفتاح Claude على الخادم وإنترنت. بدونهما يبني المحرّك مبنى
        معقولاً محلّياً. النتيجة إعادة بناء لبنية المبنى وشكله — ليست مسحاً دقيقاً؛ الجهات غير
        المصوّرة تُخمّن.
      </p>
    </Panel>
  )
}
