import { useMemo } from 'react'
import { useSim } from '../store/simStore'
import { Panel } from './Chrome'
import { paramsFromPrompt, renderPart, shapeForPart } from './partTextures'

/** Browser for the vehicle's parts; selecting one drives the generator panel. */
export function PartsGrid() {
  const parts = useSim((s) => s.parts)
  const selected = useSim((s) => s.selectedPartId)
  const selectPart = useSim((s) => s.selectPart)
  const generated = useSim((s) => s.generated)
  const activeTextureId = useSim((s) => s.activeTextureId)

  // Base thumbnails are stable per part; regenerate only when the list changes.
  const thumbs = useMemo(() => {
    const out: Record<string, string> = {}
    for (const p of parts) {
      out[p.id] = renderPart(
        shapeForPart(p.id),
        paramsFromPrompt('طين خفيف وصدأ خفيف', p.id.length * 977 + 13),
        120,
        90,
      )
    }
    return out
  }, [parts])

  return (
    <Panel title="أجزاء المركبة" className="min-h-0 min-w-0" bodyClassName="min-h-0 overflow-y-auto p-3">
      <ul className="grid grid-cols-5 gap-2">
        {parts.map((p) => {
          // Show the applied texture when one has been generated for this part.
          const applied = (generated[p.id] ?? []).find((g) => g.id === activeTextureId)
          const src = applied?.url ?? thumbs[p.id]
          const isSelected = p.id === selected
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => selectPart(p.id)}
                aria-pressed={isSelected}
                className={`flex w-full flex-col overflow-hidden rounded-md border transition-colors ${
                  isSelected ? 'border-brand-500' : 'border-ink-600 hover:border-ink-500'
                }`}
              >
                <span className="block aspect-[4/3] w-full bg-ink-900">
                  <img src={src} alt="" className="h-full w-full object-cover" />
                </span>
                <span className="block truncate px-1 py-1 text-center text-[9.5px] leading-tight text-mist-400">
                  {p.label}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
