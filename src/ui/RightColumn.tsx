import { useState } from 'react'
import { AIPanel } from './AIPanel'
import { PartsGrid } from './PartsGrid'
import { PhotoStudio } from './PhotoStudio'
import { RegionPanel } from './RegionPanel'
import { BuildingStudio } from './BuildingStudio'
import { IconAI, IconAssets, IconMountain, IconVehicle } from './icons'

type Tab = 'generate' | 'photo' | 'region' | 'building'

/**
 * The right-hand column carries the three workflows that put surfaces into the
 * world: generating a texture from a prompt, deriving one from a real photo,
 * and dressing a whole real neighbourhood. They are tabbed rather than stacked
 * because each needs the full column height — the photo tool has a
 * corner-dragging canvas, the region tool a swatch list per surface.
 */
export function RightColumn() {
  const [tab, setTab] = useState<Tab>('generate')

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
      <div className="flex gap-1 rounded-xl border border-ink-700 bg-ink-850 p-1">
        <TabButton
          active={tab === 'generate'}
          onClick={() => setTab('generate')}
          Icon={IconAI}
          label="توليد بالذكاء الصناعي"
        />
        <TabButton
          active={tab === 'photo'}
          onClick={() => setTab('photo')}
          Icon={IconAssets}
          label="استوديو الصور"
        />
        <TabButton
          active={tab === 'region'}
          onClick={() => setTab('region')}
          Icon={IconMountain}
          label="المنطقة"
        />
        <TabButton
          active={tab === 'building'}
          onClick={() => setTab('building')}
          Icon={IconVehicle}
          label="مبنى"
        />
      </div>

      {tab === 'generate' && (
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
          <AIPanel />
          <PartsGrid />
        </div>
      )}
      {tab === 'photo' && (
        <div className="min-h-0">
          <PhotoStudio />
        </div>
      )}
      {tab === 'region' && (
        <div className="min-h-0">
          <RegionPanel />
        </div>
      )}
      {tab === 'building' && (
        <div className="min-h-0">
          <BuildingStudio />
        </div>
      )}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  Icon: typeof IconAI
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[12px] transition-colors ${
        active
          ? 'bg-brand-500/15 font-medium text-brand-400'
          : 'text-mist-400 hover:bg-ink-800 hover:text-mist-200'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  )
}
