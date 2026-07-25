import { useSim } from '../store/simStore'
import { Panel } from './Chrome'
import { IconClose, IconExpand } from './icons'

/** Circular gauge matching the reference dashboard's readouts. */
function Gauge({
  label,
  value,
  display,
  tone,
}: {
  label: string
  value: number
  display: string
  tone: 'good' | 'warn' | 'bad' | 'neutral'
}) {
  const r = 21
  const circumference = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(1, value))
  // Leave a gap at the bottom so the ring reads as a gauge, not a pie.
  const arc = 0.78
  const dash = circumference * arc * clamped
  const rest = circumference - dash

  const stroke = {
    good: 'var(--color-good-500)',
    warn: 'var(--color-warn-500)',
    bad: 'var(--color-bad-500)',
    neutral: 'var(--color-mist-400)',
  }[tone]

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative h-[58px] w-[58px]">
        <svg viewBox="0 0 58 58" className="h-full w-full -rotate-[125deg]">
          <circle
            cx="29" cy="29" r={r} fill="none" stroke="var(--color-ink-700)" strokeWidth="5"
            strokeDasharray={`${circumference * arc} ${circumference}`} strokeLinecap="round"
          />
          <circle
            cx="29" cy="29" r={r} fill="none" stroke={stroke} strokeWidth="5"
            strokeDasharray={`${dash} ${rest}`} strokeLinecap="round"
          />
        </svg>
        <span className="absolute inset-0 grid place-content-center text-[12px] font-semibold tabular-nums text-mist-200">
          {display}
        </span>
      </div>
      <span className="text-[11px] text-mist-400">{label}</span>
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-ink-700 py-2 last:border-b-0">
      <span className="text-[12px] text-mist-400">{label}</span>
      <span className={`text-[13px] font-semibold tabular-nums ${accent ?? 'text-mist-200'}`}>
        {value}
      </span>
    </div>
  )
}

/**
 * Side-view schematic. The four corner markers are driven by live wheel sinkage,
 * so the diagram shows which tyres are actually buried.
 */
function Blueprint({ sink }: { sink: [number, number, number, number] }) {
  // sink order is FL, FR, RL, RR; the side view shows front-left and rear-left.
  const cornerColor = (v: number) =>
    v > 0.66 ? 'var(--color-bad-500)' : v > 0.33 ? 'var(--color-warn-500)' : 'var(--color-good-500)'

  return (
    <svg viewBox="0 0 240 120" className="h-full w-full" aria-label="مخطط المركبة">
      <g fill="none" stroke="var(--color-mist-400)" strokeWidth="1.2" opacity="0.75">
        {/* body */}
        <path d="M22 84h196" />
        <path d="M30 84V64l16-22h60l8 22h74v20" />
        <path d="M46 42h58l8 22H46z" />
        <path d="M74 42v22" />
        {/* bed */}
        <path d="M114 64h96v20h-96z" />
        <path d="M128 64v20M148 64v20M168 64v20M188 64v20" opacity="0.45" />
        {/* wheel arches */}
        <path d="M52 84a14 14 0 0 1 28 0" />
        <path d="M164 84a14 14 0 0 1 28 0" />
      </g>

      {/* wheels */}
      <g>
        <circle cx="66" cy="88" r="13" fill="none" stroke="var(--color-mist-300)" strokeWidth="2" />
        <circle cx="178" cy="88" r="13" fill="none" stroke="var(--color-mist-300)" strokeWidth="2" />
        <circle cx="66" cy="88" r="5" fill="none" stroke="var(--color-mist-400)" strokeWidth="1.2" />
        <circle cx="178" cy="88" r="5" fill="none" stroke="var(--color-mist-400)" strokeWidth="1.2" />
      </g>

      {/* suspension indicators */}
      <g strokeWidth="2.4" strokeLinecap="round">
        <path d="M66 74v-14" stroke={cornerColor(sink[0])} />
        <path d="M178 74v-14" stroke={cornerColor(sink[2])} />
      </g>
      <g fill="none" strokeWidth="1.6" opacity="0.8">
        <path d="M60 70h12M60 66h12M60 62h12" stroke={cornerColor(sink[0])} />
        <path d="M172 70h12M172 66h12M172 62h12" stroke={cornerColor(sink[2])} />
      </g>

      {/* right-side corners, offset so both sides are legible */}
      <g strokeWidth="2.4" strokeLinecap="round" opacity="0.5">
        <path d="M78 76v-12" stroke={cornerColor(sink[1])} />
        <path d="M190 76v-12" stroke={cornerColor(sink[3])} />
      </g>
    </svg>
  )
}

export function VehicleState() {
  const t = useSim((s) => s.telemetry)
  const running = useSim((s) => s.settings.running)

  const tempTone = t.engineTempC > 105 ? 'bad' : t.engineTempC > 92 ? 'warn' : 'good'
  const fuelTone = t.fuelPct < 12 ? 'bad' : t.fuelPct < 28 ? 'warn' : 'good'
  const dmgTone = t.damagePct > 55 ? 'bad' : t.damagePct > 20 ? 'warn' : 'neutral'

  return (
    <Panel
      title="حالة المركبة"
      className="min-w-0"
      actions={
        <div className="flex items-center gap-2 text-mist-400">
          <IconExpand className="h-4 w-4" />
          <IconClose className="h-4 w-4" />
        </div>
      }
    >
      <div className="flex h-full min-w-0 flex-col gap-3">
        <div className="grid min-h-0 grid-cols-[1.35fr_1fr] gap-4">
          <div className="min-h-[104px] rounded-lg bg-ink-900/60 p-2">
            <Blueprint sink={t.wheelSink} />
          </div>
          <div className="min-w-0">
            <Stat label="سرعة" value={`${Math.round(t.speedKmh)} km/h`} />
            <Stat label="RPM" value={`${Math.round(t.rpm)}`} />
            <Stat label="نقل الحركة" value={running ? t.gear : 'P'} />
            <Stat
              label="دفع رباعي"
              value={t.awd ? 'مفعل' : 'معطل'}
              accent={t.awd ? 'text-good-500' : 'text-mist-400'}
            />
          </div>
        </div>

        <div className="mt-auto grid grid-cols-4 gap-2 pt-1">
          <Gauge
            label="المحرك"
            value={t.enginePct / 100}
            display={`${Math.round(t.enginePct)}%`}
            tone="good"
          />
          <Gauge
            label="الوقود"
            value={t.fuelPct / 100}
            display={`${Math.round(t.fuelPct)}%`}
            tone={fuelTone}
          />
          <Gauge
            label="الضرر"
            value={t.damagePct / 100}
            display={`${Math.round(t.damagePct)}%`}
            tone={dmgTone}
          />
          <Gauge
            label="حرارة المحرك"
            value={Math.min(1, t.engineTempC / 130)}
            display={`${Math.round(t.engineTempC)}°C`}
            tone={tempTone}
          />
        </div>
      </div>
    </Panel>
  )
}
