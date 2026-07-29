import type { CSSProperties, ReactNode } from 'react'

export const C = {
  bg: '#0b0f14',
  panel: '#111823',
  panel2: '#0e1520',
  border: '#1e2836',
  text: '#e6edf3',
  dim: '#8b98a9',
  faint: '#5b6675',
  accent: '#f0b429',
  green: '#3fb950',
  red: '#f85149',
  blue: '#4a9eff',
  purple: '#a371f7',
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18, ...style }}>
      {children}
    </div>
  )
}

export function StatTile({ label, value, delta, color = C.accent }: { label: string; value: string; delta?: string; color?: string }) {
  return (
    <Card style={{ padding: 16 }}>
      <div style={{ color: C.dim, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 6, color: C.text }}>{value}</div>
      {delta && <div style={{ fontSize: 12, color, marginTop: 4 }}>{delta}</div>}
    </Card>
  )
}

export function Badge({ children, color }: { children: ReactNode; color: string }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color, background: `${color}22`, border: `1px solid ${color}55`, padding: '2px 8px', borderRadius: 999 }}>
      {children}
    </span>
  )
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 13, color: C.dim, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>{children}</div>
}

/** A tiny dependency-free bar chart (inline SVG). */
export function BarChart({ data, height = 150 }: { data: { label: string; value: number }[]; height?: number }) {
  const max = Math.max(...data.map((d) => d.value), 1)
  const bw = 100 / data.length
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ width: '100%', height }}>
      {data.map((d, i) => {
        const h = (d.value / max) * (height - 24)
        return (
          <g key={i}>
            <rect x={i * bw + bw * 0.18} y={height - 18 - h} width={bw * 0.64} height={h} rx={1.2} fill={C.accent} opacity={0.9} />
            <text x={i * bw + bw / 2} y={height - 5} fontSize={4.5} fill={C.dim} textAnchor="middle">{d.label}</text>
          </g>
        )
      })}
    </svg>
  )
}
