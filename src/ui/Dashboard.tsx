import { Sidebar, TopBar } from './Chrome'
import { Viewport } from './Viewport'
import { ViewportOverlay } from './ViewportOverlay'
import { SimSettings } from './SimSettings'
import { VehicleState } from './VehicleState'
import { AssetsPanel } from './AssetsPanel'
import { RightColumn } from './RightColumn'

/**
 * Three-column layout from the reference: navigation, the live simulation with
 * its controls and readouts, and the generation/parts column.
 */
export function Dashboard() {
  return (
    <div className="flex h-full flex-col bg-ink-950">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        <Sidebar />

        <main className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_360px] gap-3 p-3">
          {/* centre column */}
          {/* The controls row needs a floor: below ~250px the settings panel's
              action buttons get clipped, and the viewport is happy to shrink. */}
          <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1.4fr)_minmax(252px,1fr)_auto] gap-3">
            <Viewport>
              <ViewportOverlay />
            </Viewport>

            <div className="grid min-h-0 grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] gap-3">
              <SimSettings />
              <VehicleState />
            </div>

            <AssetsPanel />
          </div>

          <RightColumn />
        </main>
      </div>
    </div>
  )
}
