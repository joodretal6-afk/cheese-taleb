import { useSim, type WeatherKind } from '../store/simStore'
import { IconCloud, IconRain, IconSearch, IconSnow, IconSun } from './icons'

const WEATHER: { id: WeatherKind; label: string; Icon: typeof IconSun }[] = [
  { id: 'clear', label: 'صافٍ', Icon: IconSun },
  { id: 'rain', label: 'ممطر', Icon: IconRain },
  { id: 'overcast', label: 'غائم', Icon: IconCloud },
  { id: 'snow', label: 'ثلجي', Icon: IconSnow },
]

/** FPS badge and weather switcher floating over the 3D canvas. */
export function ViewportOverlay() {
  const fps = useSim((s) => s.telemetry.fps)
  const mode = useSim((s) => s.telemetry.mode)
  const footSpeed = useSim((s) => s.telemetry.footSpeedKmh)
  const canEnter = useSim((s) => s.telemetry.canEnterVehicle)
  const weather = useSim((s) => s.settings.weather)
  const running = useSim((s) => s.settings.running)
  const set = useSim((s) => s.set)

  return (
    <>
      <div className="pointer-events-none absolute start-3 top-3 flex items-center gap-2">
        <span className="rounded-md bg-ink-950/75 px-2.5 py-1 text-[11px] font-medium tabular-nums text-mist-200 backdrop-blur-sm">
          FPS: {fps}
        </span>
        {!running ? (
          <span className="rounded-md bg-ink-950/75 px-2.5 py-1 text-[11px] text-mist-400 backdrop-blur-sm">
            متوقفة — اضغط «بدء المحاكاة»
          </span>
        ) : (
          mode === 'onfoot' && (
            <span className="rounded-md bg-brand-500/85 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
              على الأقدام · {footSpeed} km/h
            </span>
          )
        )}
      </div>

      <div className="absolute end-3 top-3 rounded-lg bg-ink-950/75 p-2 backdrop-blur-sm">
        <div className="mb-1.5 flex items-center justify-between gap-6 px-0.5">
          <IconSearch className="h-3.5 w-3.5 text-mist-400" />
          <span className="text-[11px] text-mist-300" dir="ltr">
            Weather
          </span>
        </div>
        <div className="flex gap-1">
          {WEATHER.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={weather === id}
              onClick={() => set('weather', id)}
              className={`grid h-7 w-7 place-content-center rounded-md transition-colors ${
                weather === id
                  ? 'bg-brand-500 text-white'
                  : 'bg-ink-800/80 text-mist-400 hover:bg-ink-700 hover:text-mist-200'
              }`}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>

      {/* Contextual prompt: only shown when pressing F would actually do something. */}
      {running && (mode === 'driving' || canEnter) && (
        <div className="pointer-events-none absolute bottom-14 left-1/2 -translate-x-1/2 rounded-lg bg-ink-950/85 px-3 py-1.5 text-[12px] text-mist-200 backdrop-blur-sm">
          <kbd className="me-1.5 rounded bg-ink-700 px-1.5 py-0.5 text-[11px] font-semibold">F</kbd>
          {mode === 'driving' ? 'للنزول من المركبة' : 'للركوب'}
        </div>
      )}

      <div className="pointer-events-none absolute bottom-3 start-3 rounded-md bg-ink-950/70 px-2.5 py-1.5 text-[10.5px] leading-4 text-mist-400 backdrop-blur-sm">
        {mode === 'driving' ? (
          <>
            <span dir="ltr">W A S D</span> للقيادة · <span dir="ltr">Space</span> مكابح اليد ·{' '}
            <span dir="ltr">F</span> نزول · <span dir="ltr">R</span> إعادة
          </>
        ) : (
          <>
            <span dir="ltr">W A S D</span> للمشي · <span dir="ltr">Shift</span> جري ·{' '}
            <span dir="ltr">Space</span> قفز · <span dir="ltr">F</span> ركوب
          </>
        )}
        {' · '}اسحب بالفأرة لتدوير الكاميرا
      </div>
    </>
  )
}
