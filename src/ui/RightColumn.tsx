import { useState } from 'react'
import { AIPanel } from './AIPanel'
import { PartsGrid } from './PartsGrid'
import { PhotoStudio } from './PhotoStudio'
import { IconAI, IconAssets } from './icons'

type Tab = 'generate' | 'photo'

/**
 * The right-hand column carries two workflows that both end in "a texture on a
 * part": generating one from a prompt, and deriving one from a real photo. They
 * are tabbed rather than stacked because each needs the full column height —
 * the photo tool in particular has a corner-dragging canvas.
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
      </div>

      {tab === 'generate' ? (
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
          <AIPanel />
          <PartsGrid />
        </div>
      ) : (
        <div className="min-h-0">
          <PhotoStudio />
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
