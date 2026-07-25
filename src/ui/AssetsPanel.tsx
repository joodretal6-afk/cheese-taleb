import { useMemo } from 'react'
import { useSim } from '../store/simStore'
import { Panel } from './Chrome'
import { materialSwatch } from '../engine/proceduralTextures'

const TABS = [
  { id: 'mud', label: 'الطين', kind: 'mud' as const },
  { id: 'rock', label: 'الحجارة', kind: 'rock' as const },
  { id: 'water', label: 'المياه', kind: 'mud' as const },
  { id: 'plants', label: 'النباتات', kind: 'grass' as const },
  { id: 'terrain', label: 'التضاريس', kind: 'dirt' as const },
]

/**
 * Material browser. Swatches are rendered from the same procedural specs the
 * terrain shader samples, so what you pick here is what the ground is made of.
 */
export function AssetsPanel() {
  const tab = useSim((s) => s.materialTab)
  const setTab = useSim((s) => s.setMaterialTab)
  const selected = useSim((s) => s.selectedMaterial)
  const setSelected = useSim((s) => s.setSelectedMaterial)

  const active = TABS.find((t) => t.id === tab) ?? TABS[0]

  // Regenerating 8 swatches is ~15 ms; memoise so tab switches stay instant.
  const swatches = useMemo(
    () => Array.from({ length: 8 }, (_, i) => materialSwatch(active.kind, i, 96)),
    [active.kind],
  )

  return (
    <Panel title="المواد والأصول" className="min-w-0" bodyClassName="flex flex-col gap-3 p-4 pt-3">
      <div className="flex shrink-0 gap-4 border-b border-ink-700">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-1 pb-2 text-[12px] transition-colors ${
              t.id === tab
                ? 'border-brand-500 font-medium text-brand-400'
                : 'border-transparent text-mist-400 hover:text-mist-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-8 gap-2">
        {swatches.map((src, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setSelected(i)}
            aria-pressed={i === selected}
            className={`relative aspect-[4/3] overflow-hidden rounded-md border transition-colors ${
              i === selected ? 'border-brand-500' : 'border-ink-600 hover:border-ink-500'
            }`}
          >
            <img src={src} alt="" className="h-full w-full object-cover" />
            {i === selected && (
              <span className="absolute bottom-1 end-1 grid h-4 w-4 place-content-center rounded-full bg-brand-500 text-white">
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3.5">
                  <path d="m5 12.5 4.5 4.5L19 7" />
                </svg>
              </span>
            )}
          </button>
        ))}
      </div>
    </Panel>
  )
}
