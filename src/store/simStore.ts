import { create } from 'zustand'

export type WeatherKind = 'clear' | 'rain' | 'overcast' | 'snow'
export type TerrainQuality = 'low' | 'medium' | 'high' | 'ultra'

/** Knobs the dashboard exposes. The engine subscribes and applies them live. */
export interface SimSettings {
  /** Time of day in hours, 0..24. Drives sun elevation and sky colour. */
  timeOfDay: number
  weather: WeatherKind
  /** 0..1 — how deep and sticky the mud is. */
  mudIntensity: number
  /** 0..1 — surface wetness: darkens ground, adds specular sheen, cuts grip. */
  humidity: number
  /** 0..1 mapped to -10..45 °C — affects engine warm-up and mud viscosity. */
  temperature: number
  terrainQuality: TerrainQuality
  running: boolean
}

/** Read-only stream published by the engine at ~10 Hz. */
export interface Telemetry {
  fps: number
  speedKmh: number
  rpm: number
  gear: string
  awd: boolean
  enginePct: number
  fuelPct: number
  damagePct: number
  engineTempC: number
  /** 0..1 per wheel, how deep each tyre is sitting in mud. */
  wheelSink: [number, number, number, number]
  /** 0..1, how much mud is caked onto the body. */
  bodyMud: number
}

export interface VehiclePart {
  id: string
  label: string
  /** Node-name fragments in the GLB this part maps to. */
  meshHints: string[]
  /** 0..1 damage, driven by the simulation. */
  damage: number
}

export interface GeneratedTexture {
  id: string
  partId: string
  prompt: string
  /** Data URL of the generated albedo map. */
  url: string
  seed: number
  createdAt: number
}

interface SimState {
  settings: SimSettings
  telemetry: Telemetry
  parts: VehiclePart[]
  selectedPartId: string
  /** Generated results, newest first, keyed by part. */
  generated: Record<string, GeneratedTexture[]>
  activeTextureId: string | null
  materialTab: string
  selectedMaterial: number
  engineReady: boolean
  loadProgress: number
  activeSection: string

  set: <K extends keyof SimSettings>(key: K, value: SimSettings[K]) => void
  pushTelemetry: (t: Partial<Telemetry>) => void
  selectPart: (id: string) => void
  addGenerated: (tex: GeneratedTexture) => void
  setActiveTexture: (id: string | null) => void
  setMaterialTab: (tab: string) => void
  setSelectedMaterial: (i: number) => void
  setEngineReady: (v: boolean) => void
  setLoadProgress: (v: number) => void
  setActiveSection: (s: string) => void
  setPartDamage: (id: string, damage: number) => void
}

/**
 * Part list mirrors the reference dashboard. `meshHints` are matched against the
 * KeyShot-exported node names in frontier.glb so a selected part can be
 * highlighted and re-textured in the 3D scene.
 */
const PARTS: VehiclePart[] = [
  { id: 'front-fascia', label: 'الواجهة الأمامية', meshHints: ['vwpassatts001'], damage: 0 },
  { id: 'hood', label: 'الغطاء', meshHints: ['Matte__FFCCCCCC'], damage: 0 },
  { id: 'roof', label: 'السقف', meshHints: ['Matte__FFFFFFFF'], damage: 0 },
  { id: 'door-fl', label: 'الباب الأمامي الأيسر', meshHints: ['siyah__spec_'], damage: 0 },
  { id: 'door-fr', label: 'الباب الأمامي الأيمن', meshHints: ['siyah'], damage: 0 },
  { id: 'door-rl', label: 'الباب الخلفي الأيسر', meshHints: ['preto__spec_'], damage: 0 },
  { id: 'door-rr', label: 'الباب الخلفي الأيمن', meshHints: ['preto'], damage: 0 },
  { id: 'bumper-f', label: 'الصدام الأمامي', meshHints: ['Matte__FF808040'], damage: 0 },
  { id: 'bed', label: 'الصندوق الخلفي', meshHints: ['vehiclegeneric256'], damage: 0 },
  { id: 'bumper-r', label: 'الصدام الخلفي', meshHints: ['Matte__FF191717'], damage: 0 },
  { id: 'wheel-fl', label: 'العجلة الأمامية اليسرى', meshHints: ['WHEEL_FL'], damage: 0 },
  { id: 'wheel-fr', label: 'العجلة الأمامية اليمنى', meshHints: ['WHEEL_FR'], damage: 0 },
  { id: 'wheel-rl', label: 'العجلة الخلفية اليسرى', meshHints: ['WHEEL_RL'], damage: 0 },
  { id: 'wheel-rr', label: 'العجلة الخلفية اليمنى', meshHints: ['WHEEL_RR'], damage: 0 },
  { id: 'windshield', label: 'الزجاج الأمامي', meshHints: ['glass'], damage: 0 },
  { id: 'rear-glass', label: 'الزجاج الخلفي', meshHints: ['vehicle_generic_glasswindows2'], damage: 0 },
  { id: 'mirrors', label: 'المرايا', meshHints: ['Matte__FF050505'], damage: 0 },
  { id: 'headlights', label: 'المصابيح الأمامية', meshHints: ['farosv2__trans_F'], damage: 0 },
  { id: 'taillights', label: 'المصابيح الخلفية', meshHints: ['farosv2__trans_R'], damage: 0 },
]

/** `?quality=low` lets the headless harness boot a cheap scene on SwiftShader. */
function initialQuality(): TerrainQuality {
  const q = new URLSearchParams(globalThis.location?.search ?? '').get('quality')
  return q === 'low' || q === 'medium' || q === 'high' || q === 'ultra' ? q : 'high'
}

export const useSim = create<SimState>((set) => ({
  settings: {
    timeOfDay: 12,
    weather: 'overcast',
    mudIntensity: 0.85,
    humidity: 0.7,
    temperature: 0.6,
    terrainQuality: initialQuality(),
    running: false,
  },
  telemetry: {
    fps: 0,
    speedKmh: 0,
    rpm: 0,
    gear: 'P',
    awd: true,
    enginePct: 87,
    fuelPct: 65,
    damagePct: 0,
    engineTempC: 62,
    wheelSink: [0, 0, 0, 0],
    bodyMud: 0,
  },
  parts: PARTS,
  selectedPartId: 'door-fr',
  generated: {},
  activeTextureId: null,
  materialTab: 'mud',
  selectedMaterial: 3,
  engineReady: false,
  loadProgress: 0,
  activeSection: 'dashboard',

  set: (key, value) => set((s) => ({ settings: { ...s.settings, [key]: value } })),
  pushTelemetry: (t) => set((s) => ({ telemetry: { ...s.telemetry, ...t } })),
  selectPart: (id) => set({ selectedPartId: id }),
  addGenerated: (tex) =>
    set((s) => ({
      generated: { ...s.generated, [tex.partId]: [tex, ...(s.generated[tex.partId] ?? [])].slice(0, 8) },
      activeTextureId: tex.id,
    })),
  setActiveTexture: (id) => set({ activeTextureId: id }),
  setMaterialTab: (tab) => set({ materialTab: tab }),
  setSelectedMaterial: (i) => set({ selectedMaterial: i }),
  setEngineReady: (v) => set({ engineReady: v }),
  setLoadProgress: (v) => set({ loadProgress: v }),
  setActiveSection: (s) => set({ activeSection: s }),
  setPartDamage: (id, damage) =>
    set((s) => ({ parts: s.parts.map((p) => (p.id === id ? { ...p, damage } : p)) })),
}))

/** Non-reactive snapshot for the render loop — avoids a React subscription per frame. */
export const simSnapshot = () => useSim.getState()

// Exposed so the headless screenshot harness can drive the sim without the UI.
;(globalThis as unknown as { __simStore: typeof useSim }).__simStore = useSim
