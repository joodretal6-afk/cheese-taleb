import { useEffect, useRef, useState } from 'react'
import { MapEditor, type Tool } from './editor/MapEditor'
import { parseMap, serializeMap } from './map/phxmap'

const SCULPT: { key: Tool; label: string; icon: string }[] = [
  { key: 'raise', label: 'Raise', icon: '⬆' },
  { key: 'lower', label: 'Lower', icon: '⬇' },
  { key: 'smooth', label: 'Smooth', icon: '〜' },
  { key: 'flatten', label: 'Flatten', icon: '▬' },
]
const PLACE: { key: Tool; label: string; icon: string }[] = [
  { key: 'building', label: 'Building', icon: '🏢' },
  { key: 'tree', label: 'Tree', icon: '🌲' },
  { key: 'rock', label: 'Rock', icon: '🪨' },
  { key: 'spawn', label: 'Spawn', icon: '🚩' },
  { key: 'loot', label: 'Loot', icon: '📦' },
  { key: 'vehicle', label: 'Vehicle', icon: '🚗' },
]
const SPECIAL: { key: Tool; label: string; icon: string }[] = [
  { key: 'gas', label: 'Gas center', icon: '🎯' },
  { key: 'erase', label: 'Erase', icon: '✖' },
]

const SCULPT_KEYS: Tool[] = ['raise', 'lower', 'smooth', 'flatten']

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const editorRef = useRef<MapEditor | null>(null)
  const [tool, setTool] = useState<Tool>('raise')
  const [radius, setRadius] = useState(60)
  const [strength, setStrength] = useState(2)
  const [water, setWater] = useState(-8)
  const [gas, setGas] = useState(700)
  const [count, setCount] = useState(0)
  const [hover, setHover] = useState<{ x: number; z: number; h: number } | null>(null)

  useEffect(() => {
    if (!canvasRef.current || editorRef.current) return
    const ed = new MapEditor(canvasRef.current)
    ed.onHover = setHover
    ed.onChange = () => setCount(ed.objectCount())
    editorRef.current = ed
    setWater(ed.getWaterLevel())
    setGas(ed.getGasRadius())
    ;(window as unknown as { __editor: MapEditor }).__editor = ed
    return () => {
      ed.dispose()
      editorRef.current = null
    }
  }, [])

  useEffect(() => void editorRef.current?.setTool(tool), [tool])
  useEffect(() => void editorRef.current?.setRadius(radius), [radius])
  useEffect(() => void editorRef.current?.setStrength(strength), [strength])
  useEffect(() => void editorRef.current?.setWaterLevel(water), [water])
  useEffect(() => void editorRef.current?.setGasRadius(gas), [gas])

  function save() {
    const ed = editorRef.current
    if (!ed) return
    const blob = new Blob([serializeMap(ed.getMap())], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${ed.getMap().meta.name}.phxmap.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function load(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    file.text().then((t) => {
      try {
        const ed = editorRef.current
        if (!ed) return
        ed.loadMap(parseMap(t))
        setWater(ed.getWaterLevel())
        setGas(ed.getGasRadius())
        setCount(ed.objectCount())
      } catch (err) {
        alert(`Load failed: ${(err as Error).message}`)
      }
    })
    e.target.value = ''
  }

  const isSculpt = SCULPT_KEYS.includes(tool)
  const btnFor = (item: { key: Tool; label: string; icon: string }) => (
    <button key={item.key} onClick={() => setTool(item.key)} style={tool === item.key ? toolActive : toolBtn} title={item.label}>
      <span style={{ fontSize: 15 }}>{item.icon}</span>
      <span style={{ fontSize: 9.5 }}>{item.label}</span>
    </button>
  )

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} />

      <div style={bar}>
        <span style={{ fontWeight: 700, color: '#f0b429', letterSpacing: 0.5 }}>PHOENIX</span>
        <span style={{ color: '#8b98a9', fontSize: 12 }}>Map Editor</span>
        <div style={{ flex: 1 }} />
        <button style={btn} onClick={() => editorRef.current?.newMap()}>New</button>
        <button style={btn} onClick={save}>Save</button>
        <label style={{ ...btn, cursor: 'pointer' }}>
          Load
          <input type="file" accept=".json,.phxmap" onChange={load} style={{ display: 'none' }} />
        </label>
      </div>

      <div style={panel}>
        <div style={section}>Terrain</div>
        <div style={grid}>{SCULPT.map(btnFor)}</div>

        {isSculpt && (
          <>
            <label style={slabel}>
              Brush size <b style={val}>{radius} m</b>
              <input type="range" min={8} max={300} value={radius} onChange={(e) => setRadius(+e.target.value)} />
            </label>
            <label style={slabel}>
              Strength <b style={val}>{strength} m</b>
              <input type="range" min={0.2} max={12} step={0.2} value={strength} onChange={(e) => setStrength(+e.target.value)} />
            </label>
          </>
        )}

        <div style={section}>Place</div>
        <div style={grid}>{PLACE.map(btnFor)}</div>
        <div style={{ display: 'flex', gap: 6 }}>{SPECIAL.map(btnFor)}</div>

        <div style={section}>World</div>
        <label style={slabel}>
          Water level <b style={val}>{water} m</b>
          <input type="range" min={-60} max={80} value={water} onChange={(e) => setWater(+e.target.value)} />
        </label>
        <label style={slabel}>
          Gas radius <b style={val}>{gas} m</b>
          <input type="range" min={50} max={1400} step={10} value={gas} onChange={(e) => setGas(+e.target.value)} />
        </label>

        <div style={{ marginTop: 2, color: '#6b7280', fontSize: 11, lineHeight: 1.5 }}>
          Left: use tool · Right: orbit · Middle: pan · Wheel: zoom
        </div>
      </div>

      <div style={hud}>
        {hover ? `x ${hover.x.toFixed(0)}  z ${hover.z.toFixed(0)}  ·  ${hover.h.toFixed(1)} m` : 'move over the terrain…'}
        <span style={{ color: '#f0b429', marginLeft: 12 }}>objects: {count}</span>
      </div>
    </div>
  )
}

const bar: React.CSSProperties = {
  position: 'absolute', top: 0, left: 0, right: 0, height: 44, display: 'flex', alignItems: 'center', gap: 10,
  padding: '0 14px', background: 'rgba(13,17,23,0.9)', borderBottom: '1px solid #222b36', color: '#e6edf3',
}
const panel: React.CSSProperties = {
  position: 'absolute', top: 56, left: 12, width: 236, display: 'flex', flexDirection: 'column', gap: 8,
  padding: 12, borderRadius: 12, background: 'rgba(13,17,23,0.92)', border: '1px solid #222b36', color: '#e6edf3',
  maxHeight: 'calc(100% - 76px)', overflowY: 'auto',
}
const section: React.CSSProperties = { color: '#8b98a9', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }
const toolBtn: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '7px 2px',
  borderRadius: 8, border: '1px solid #2b3441', background: '#161b22', color: '#c9d1d9', cursor: 'pointer',
}
const toolActive: React.CSSProperties = { ...toolBtn, background: '#f0b429', color: '#1a1200', borderColor: '#f0b429' }
const btn: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 8, border: '1px solid #2b3441', background: '#161b22', color: '#c9d1d9', fontSize: 13, cursor: 'pointer',
}
const slabel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#c9d1d9' }
const val: React.CSSProperties = { color: '#f0b429', float: 'right' }
const hud: React.CSSProperties = {
  position: 'absolute', bottom: 12, left: 12, padding: '6px 12px', borderRadius: 8,
  background: 'rgba(13,17,23,0.9)', border: '1px solid #222b36', color: '#8b98a9', fontSize: 12, fontFamily: 'monospace',
}
