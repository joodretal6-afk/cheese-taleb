import { useEffect, useMemo, useRef, useState } from 'react'
import { useSim } from '../store/simStore'
import { Panel } from './Chrome'
import { IconCheck, IconSparkles } from './icons'
import { paramsFromPrompt, renderPart, requestWearTexture, shapeForPart } from './partTextures'

type SimWindow = Window & {
  sim?: { applyPartTexture(id: string, url: string): number; highlightPart(id: string | null): void }
}

const DEFAULT_PROMPT =
  'تكشير عالي الجودة لباب سيارة نيسان بيك اب\nمظهر طيني وخدوش خفيفة وواقعي\n4k'

/**
 * The generator panel from the reference.
 *
 * Generation runs through requestWearTexture(), which synthesises locally by
 * default and forwards to a hosted image model when VITE_TEXTURE_API is set.
 * Picking a result applies it to that part in the live 3D scene.
 */
export function AIPanel() {
  const parts = useSim((s) => s.parts)
  const selectedPartId = useSim((s) => s.selectedPartId)
  const selectPart = useSim((s) => s.selectPart)
  const generated = useSim((s) => s.generated)
  const addGenerated = useSim((s) => s.addGenerated)
  const activeTextureId = useSim((s) => s.activeTextureId)
  const setActiveTexture = useSim((s) => s.setActiveTexture)

  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const seedRef = useRef(1)

  const results = generated[selectedPartId] ?? []
  const part = parts.find((p) => p.id === selectedPartId)

  // Preview reflects the current prompt without needing a generate click.
  const preview = useMemo(
    () => renderPart(shapeForPart(selectedPartId), paramsFromPrompt(prompt, 7), 200, 150),
    [selectedPartId, prompt],
  )

  const engineReady = useSim((s) => s.engineReady)
  useEffect(() => {
    if (!engineReady) return
    try {
      ;(window as SimWindow).sim?.highlightPart(selectedPartId)
    } catch (err) {
      console.warn('[ui] highlightPart failed', err)
    }
  }, [selectedPartId, engineReady])

  async function generate() {
    setBusy(true)
    setStatus(null)
    try {
      // Four variants, as in the reference — same prompt, different seeds.
      for (let i = 0; i < 4; i++) {
        const seed = (seedRef.current = (seedRef.current * 1103515245 + 12345) >>> 0)
        const url = await requestWearTexture(prompt, selectedPartId, seed)
        addGenerated({
          id: `${selectedPartId}-${seed}`,
          partId: selectedPartId,
          prompt,
          url,
          seed,
          createdAt: Date.now(),
        })
      }
      setStatus('تم توليد 4 نتائج')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'فشل التوليد')
    } finally {
      setBusy(false)
    }
  }

  function apply(id: string, url: string) {
    setActiveTexture(id)
    const applied = (window as SimWindow).sim?.applyPartTexture(selectedPartId, url) ?? 0
    setStatus(
      applied > 0
        ? `تم تطبيق التكشير على ${applied} شبكة في المشهد`
        : 'لم يُعثر على شبكات مطابقة لهذا الجزء',
    )
  }

  return (
    <Panel title="الذكاء الصناعي - توليد تكشير" className="min-w-0" bodyClassName="p-4">
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <div className="min-w-0 space-y-2.5">
          <label className="block">
            <span className="mb-1 block text-[11px] text-mist-400">نوع الجزء</span>
            <select
              className="w-full rounded-md border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-[12px] text-mist-200 outline-none focus:border-brand-500"
              value={selectedPartId}
              onChange={(e) => selectPart(e.target.value)}
            >
              {parts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] text-mist-400">وصف ما تريد توليده</span>
            <textarea
              rows={4}
              className="w-full resize-y rounded-md border border-ink-600 bg-ink-800 px-2.5 py-2 text-[12px] leading-5 text-mist-200 outline-none focus:border-brand-500"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
        </div>

        <div className="w-[112px] shrink-0">
          <span className="mb-1 block text-[11px] text-mist-400">معاينة</span>
          <div className="overflow-hidden rounded-md border border-ink-600 bg-ink-900">
            <img src={preview} alt="معاينة الجزء" className="h-[84px] w-full object-cover" />
          </div>
          {part && <p className="mt-1 truncate text-[10px] text-mist-400">{part.label}</p>}
        </div>
      </div>

      <button
        type="button"
        onClick={generate}
        disabled={busy}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-linear-to-l from-brand-500 to-accent-500 px-3 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        <IconSparkles className="h-4 w-4" />
        {busy ? 'جارٍ التوليد…' : 'توليد الصورة'}
      </button>

      {status && <p className="mt-2 text-[11px] text-mist-400">{status}</p>}

      <div className="mt-4">
        <h3 className="mb-2 text-[12px] font-medium text-mist-300">النتائج</h3>
        {results.length === 0 ? (
          <p className="rounded-lg border border-dashed border-ink-600 px-3 py-4 text-center text-[11px] text-mist-400">
            لا توجد نتائج بعد — اضغط «توليد الصورة»
          </p>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {results.slice(0, 4).map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => apply(r.id, r.url)}
                className={`relative aspect-[4/3] overflow-hidden rounded-md border transition-colors ${
                  r.id === activeTextureId
                    ? 'border-brand-500'
                    : 'border-ink-600 hover:border-ink-500'
                }`}
              >
                <img src={r.url} alt="" className="h-full w-full object-cover" />
                {r.id === activeTextureId && (
                  <span className="absolute top-1 start-1 grid h-4 w-4 place-content-center rounded-full bg-brand-500 text-white">
                    <IconCheck className="h-3 w-3" />
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </Panel>
  )
}
