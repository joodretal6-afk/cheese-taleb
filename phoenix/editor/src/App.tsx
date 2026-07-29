import { useEffect, useRef, useState } from 'react'
import { MapEditor } from './editor/MapEditor'
import type { BrushMode } from './editor/Terrain'
import { parseMap, serializeMap } from './map/phxmap'

const MODES: { key: BrushMode; label: string; icon: string }[] = [
  { key: 'raise', label: 'Raise', icon: '⬆' },
  { key: 'lower', label: 'Lower', icon: '⬇' },
  { key: 'smooth', label: 'Smooth', icon: '〜' },
  { key: 'flatten', label: 'Flatten', icon: '▬' },
]

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const editorRef = useRef<MapEditor | null>(null)
  const [mode, setMode] = useState<BrushMode>('raise')
  const [radius, setRadius] = useState(60)
  const [strength, setStrength] = useState(2)
  const [hover, setHover] = useState<{ x: number; z: number; h: number } | null>(null)

  useEffect(() => {
    if (!canvasRef.current || editorRef.current) return
    const ed = new MapEditor(canvasRef.current)
    ed.onHover = setHover
    editorRef.current = ed
    ;(window as unknown as { __editor: MapEditor }).__editor = ed
    return () => {
      ed.dispose()
      editorRef.current = null
    }
  }, [])

  useEffect(() => void editorRef.current?.setBrushMode(mode), [mode])
  useEffect(() => void editorRef.current?.setRadius(radius), [radius])
  useEffect(() => void editorRef.current?.setStrength(strength), [strength])

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
        editorRef.current?.loadMap(parseMap(t))
      } catch (err) {
        alert(`Load failed: ${(err as Error).message}`)
      }
    })
    e.target.value = ''
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} />

      {/* Top bar */}
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

      {/* Tool panel */}
      <div style={panel}>
        <div style={{ color: '#8b98a9', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Sculpt</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => setMode(m.key)}
              style={mode === m.key ? toolActive : tool}
              title={m.label}
            >
              <span style={{ fontSize: 16 }}>{m.icon}</span>
              <span style={{ fontSize: 10 }}>{m.label}</span>
            </button>
          ))}
        </div>

        <label style={slabel}>
          Brush size <b style={val}>{radius} m</b>
          <input type="range" min={8} max={300} value={radius} onChange={(e) => setRadius(+e.target.value)} />
        </label>
        <label style={slabel}>
          Strength <b style={val}>{strength} m</b>
          <input type="range" min={0.2} max={12} step={0.2} value={strength} onChange={(e) => setStrength(+e.target.value)} />
        </label>

        <div style={{ marginTop: 4, color: '#6b7280', fontSize: 11, lineHeight: 1.5 }}>
          Left-drag: sculpt<br />
          Right-drag: orbit · Middle-drag: pan · Wheel: zoom
        </div>
      </div>

      {/* HUD */}
      <div style={hud}>
        {hover
          ? `x ${hover.x.toFixed(0)}  z ${hover.z.toFixed(0)}  ·  height ${hover.h.toFixed(1)} m`
          : 'move over the terrain…'}
      </div>
    </div>
  )
}

// --- inline styles (kept dependency-free) ---
const bar: React.CSSProperties = {
  position: 'absolute', top: 0, left: 0, right: 0, height: 44, display: 'flex', alignItems: 'center', gap: 10,
  padding: '0 14px', background: 'rgba(13,17,23,0.9)', borderBottom: '1px solid #222b36', color: '#e6edf3',
}
const panel: React.CSSProperties = {
  position: 'absolute', top: 60, left: 12, width: 220, display: 'flex', flexDirection: 'column', gap: 10,
  padding: 12, borderRadius: 12, background: 'rgba(13,17,23,0.9)', border: '1px solid #222b36', color: '#e6edf3',
}
const tool: React.CSSProperties = {
  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '8px 4px',
  borderRadius: 8, border: '1px solid #2b3441', background: '#161b22', color: '#c9d1d9', cursor: 'pointer',
}
const toolActive: React.CSSProperties = { ...tool, background: '#f0b429', color: '#1a1200', borderColor: '#f0b429' }
const btn: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 8, border: '1px solid #2b3441', background: '#161b22', color: '#c9d1d9',
  fontSize: 13, cursor: 'pointer',
}
const slabel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#c9d1d9' }
const val: React.CSSProperties = { color: '#f0b429', float: 'right' }
const hud: React.CSSProperties = {
  position: 'absolute', bottom: 12, left: 12, padding: '6px 12px', borderRadius: 8,
  background: 'rgba(13,17,23,0.9)', border: '1px solid #222b36', color: '#8b98a9', fontSize: 12, fontFamily: 'monospace',
}
