import { useState } from 'react'
import { useSim, type TerrainQuality, type WeatherKind } from '../store/simStore'
import { DEFAULT_VEHICLE_ID, getVehicle, VEHICLES } from '../engine/vehicleCatalog'
import { Panel } from './Chrome'
import { IconPlay, IconReset, IconStop } from './icons'

const WEATHER_LABEL: Record<WeatherKind, string> = {
  clear: 'صافٍ',
  overcast: 'غائم',
  rain: 'ممطر',
  snow: 'ثلجي',
}

const QUALITY_LABEL: Record<TerrainQuality, string> = {
  low: 'منخفض',
  medium: 'متوسط',
  high: 'عالي',
  ultra: 'فائق',
}

function Slider({
  label,
  value,
  display,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
}: {
  label: string
  value: number
  display: string
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
}) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[12px] text-mist-400">{label}</span>
      <input
        type="range"
        className="h-4 min-w-0 flex-1"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        // The filled portion is drawn with a gradient on the track itself.
        style={{
          ['--track' as string]: `linear-gradient(to right, var(--color-brand-500) ${pct}%, var(--color-ink-600) ${pct}%)`,
        }}
      />
      <span className="w-12 shrink-0 text-end text-[12px] tabular-nums text-mist-300">
        {display}
      </span>
    </div>
  )
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[12px] text-mist-400">{label}</span>
      <select
        className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-[12px] text-mist-200 outline-none focus:border-brand-500"
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

type SimWindow = Window & {
  sim?: {
    vehicle?: { reset(): void }
    vehicleSpec?: { id: string }
    setVehicle?(id: string): Promise<boolean>
  }
}

export function SimSettings() {
  const s = useSim((st) => st.settings)
  const set = useSim((st) => st.set)
  const ready = useSim((st) => st.engineReady)

  // Only the Frontier's GLB ships with the app. The rest of the catalogue is
  // real, calibrated physics waiting for a model — so they are offered, and a
  // missing file is reported plainly instead of leaving the player with no car.
  const [carId, setCarId] = useState(DEFAULT_VEHICLE_ID)
  const [carNote, setCarNote] = useState<string | null>(null)

  async function pickCar(id: string) {
    const previous = carId
    setCarId(id)
    setCarNote(null)
    const swap = (window as SimWindow).sim?.setVehicle
    if (!swap) {
      setCarId(previous)
      return
    }
    const ok = await swap(id)
    if (!ok) {
      setCarId(previous)
      setCarNote(`${getVehicle(id).modelUrl} غير موجود — ضع الملف في public/models/`)
    }
  }

  const hh = Math.floor(s.timeOfDay)
  const mm = Math.round((s.timeOfDay - hh) * 60)
  const clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`

  return (
    <Panel title="إعدادات المحاكاة" className="min-w-0" bodyClassName="min-h-0 overflow-y-auto p-4">
      <div className="flex h-full min-h-0 flex-col gap-2.5">
        <Slider
          label="الوقت"
          value={s.timeOfDay}
          min={0}
          max={24}
          step={0.25}
          display={clock}
          onChange={(v) => set('timeOfDay', v)}
        />
        <Select
          label="الطقس"
          value={s.weather}
          options={(Object.keys(WEATHER_LABEL) as WeatherKind[]).map((k) => ({
            value: k,
            label: WEATHER_LABEL[k],
          }))}
          onChange={(v) => set('weather', v)}
        />
        <Slider
          label="شدة الطين"
          value={s.mudIntensity}
          display={`${Math.round(s.mudIntensity * 100)}%`}
          onChange={(v) => set('mudIntensity', v)}
        />
        <Slider
          label="الرطوبة"
          value={s.humidity}
          display={`${Math.round(s.humidity * 100)}%`}
          onChange={(v) => set('humidity', v)}
        />
        <Slider
          label="الحرارة"
          value={s.temperature}
          display={`${Math.round(-10 + s.temperature * 55)}°`}
          onChange={(v) => set('temperature', v)}
        />
        <Select
          label="التضاريس"
          value={s.terrainQuality}
          options={(Object.keys(QUALITY_LABEL) as TerrainQuality[]).map((k) => ({
            value: k,
            label: QUALITY_LABEL[k],
          }))}
          onChange={(v) => set('terrainQuality', v)}
        />
        <Select
          label="المركبة"
          value={carId}
          options={VEHICLES.map((v) => ({ value: v.id, label: v.name }))}
          onChange={(v) => void pickCar(v)}
        />
        {carNote && (
          <p className="text-[11px] leading-4 text-bad-500" dir="rtl">
            {carNote}
          </p>
        )}

        <div className="mt-auto flex gap-2 pt-1">
          <button
            type="button"
            disabled={!ready}
            onClick={() => set('running', !s.running)}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-colors disabled:opacity-40 ${
              s.running
                ? 'bg-ink-700 text-mist-200 hover:bg-ink-600'
                : 'bg-brand-500 text-white hover:bg-brand-400'
            }`}
          >
            {s.running ? <IconStop className="h-4 w-4" /> : <IconPlay className="h-4 w-4" />}
            {s.running ? 'إيقاف المحاكاة' : 'بدء المحاكاة'}
          </button>
          <button
            type="button"
            disabled={!ready}
            title="إعادة المركبة إلى نقطة البداية (R)"
            onClick={() => {
              const sim = (window as unknown as { sim?: { vehicle?: { reset(): void } } }).sim
              sim?.vehicle?.reset()
            }}
            className="grid w-11 place-content-center rounded-lg bg-ink-700 text-mist-300 transition-colors hover:bg-ink-600 disabled:opacity-40"
          >
            <IconReset className="h-4 w-4" />
          </button>
        </div>
      </div>
    </Panel>
  )
}
