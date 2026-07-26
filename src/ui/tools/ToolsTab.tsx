import { useState } from 'react'
import { CameraToolsPanel } from './CameraToolsPanel'
import { ObjectToolsPanel } from './ObjectToolsPanel'
import { SceneIOPanel } from './SceneIOPanel'
import { DevHudPanel } from './DevHudPanel'
import { WorldToolsPanel } from './WorldToolsPanel'
import { TrafficPanel } from './TrafficPanel'
import { PedestrianPanel } from './PedestrianPanel'

/**
 * The developer-tools drawer.
 *
 * Self-contained panels — camera, object editing, project I/O, the developer
 * HUD, world/measure tools, traffic and pedestrians — behind one row of
 * sub-tabs, so the main tab bar stays short and each tool still gets the full
 * column height. All operate on the already-exposed `window.sim`; nothing here
 * reaches into the engine's internals.
 */

type Tool = 'camera' | 'objects' | 'project' | 'dev' | 'world' | 'traffic' | 'peds'

const TOOLS: { id: Tool; label: string; Panel: () => React.JSX.Element }[] = [
  { id: 'camera', label: 'الكاميرا', Panel: CameraToolsPanel },
  { id: 'objects', label: 'الكائنات', Panel: ObjectToolsPanel },
  { id: 'project', label: 'المشروع', Panel: SceneIOPanel },
  { id: 'dev', label: 'المطوّر', Panel: DevHudPanel },
  { id: 'world', label: 'العالم', Panel: WorldToolsPanel },
  { id: 'traffic', label: 'المرور', Panel: TrafficPanel },
  { id: 'peds', label: 'المشاة', Panel: PedestrianPanel },
]

export function ToolsTab() {
  const [tool, setTool] = useState<Tool>('camera')
  const Active = TOOLS.find((t) => t.id === tool)!.Panel

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
      <div className="flex gap-1 overflow-x-auto rounded-lg border border-ink-700 bg-ink-850 p-1">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTool(t.id)}
            aria-pressed={tool === t.id}
            className={`shrink-0 rounded-md px-2.5 py-1.5 text-[11px] transition-colors ${
              tool === t.id
                ? 'bg-brand-500/15 font-medium text-brand-400'
                : 'text-mist-400 hover:bg-ink-800 hover:text-mist-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0">
        <Active />
      </div>
    </div>
  )
}
