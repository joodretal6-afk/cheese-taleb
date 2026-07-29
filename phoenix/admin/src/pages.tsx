import { useState } from 'react'
import type { Page } from './App'
import type { Kpis, Player, PlayerStatus, RevenuePoint } from './api'
import { BarChart, Badge, C, Card, SectionTitle, StatTile } from './theme'

const NAV: { key: Page; label: string; icon: string }[] = [
  { key: 'overview', label: 'Overview', icon: '▚' },
  { key: 'players', label: 'Players', icon: '👤' },
  { key: 'leaderboard', label: 'Leaderboard', icon: '🏆' },
  { key: 'economy', label: 'Economy', icon: '💰' },
]
const NAV_SOON = ['Battle Pass', 'Seasons', 'Store Editor', 'Clans', 'Tournaments', 'Anti-Cheat', 'Reports', 'Audit Log']

export function Nav({ page, setPage }: { page: Page; setPage: (p: Page) => void }) {
  return (
    <div style={{ width: 230, background: '#0e1520', borderRight: `1px solid ${C.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px 16px' }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: 'linear-gradient(135deg,#f0b429,#f85149)', display: 'grid', placeItems: 'center' }}>🔥</div>
        <div>
          <div style={{ fontWeight: 700, letterSpacing: 0.5 }}>PHOENIX</div>
          <div style={{ fontSize: 10, color: C.faint }}>ADMIN CONSOLE</div>
        </div>
      </div>
      {NAV.map((n) => (
        <button key={n.key} onClick={() => setPage(n.key)} style={navItem(page === n.key)}>
          <span style={{ width: 18, textAlign: 'center' }}>{n.icon}</span> {n.label}
        </button>
      ))}
      <div style={{ height: 1, background: C.border, margin: '10px 0' }} />
      <div style={{ fontSize: 10, color: C.faint, padding: '0 8px 6px', letterSpacing: 1 }}>COMING ONLINE</div>
      {NAV_SOON.map((s) => (
        <div key={s} style={{ ...navItem(false), color: C.faint, cursor: 'default' }}>
          <span style={{ width: 18, textAlign: 'center' }}>◦</span> {s}
        </div>
      ))}
    </div>
  )
}

function navItem(active: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, fontSize: 13.5,
    border: 'none', textAlign: 'left', cursor: 'pointer',
    background: active ? '#f0b42918' : 'transparent',
    color: active ? C.accent : C.dim,
    fontWeight: active ? 600 : 400,
  }
}

export function BadgeStatus() {
  return <Badge color={C.green}>LIVE</Badge>
}

function statusBadge(s: PlayerStatus) {
  if (s === 'banned') return <Badge color={C.red}>banned</Badge>
  if (s === 'muted') return <Badge color={C.accent}>muted</Badge>
  return <Badge color={C.green}>active</Badge>
}

// ---------------- Overview ----------------

export function Overview({ kpis, revenue, players }: { kpis: Kpis | null; revenue: RevenuePoint[]; players: Player[] }) {
  const fmt = (n: number) => n.toLocaleString()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14 }}>
        <StatTile label="Online now" value={kpis ? fmt(kpis.onlineNow) : '—'} delta="▲ 6.2% vs 1h ago" color={C.green} />
        <StatTile label="Daily active" value={kpis ? fmt(kpis.dailyActive) : '—'} delta="▲ 2.1% vs yesterday" color={C.green} />
        <StatTile label="Matches today" value={kpis ? fmt(kpis.matchesToday) : '—'} delta="peak 09:00 UTC" color={C.dim} />
        <StatTile label="Revenue today" value={kpis ? `$${fmt(kpis.revenueToday)}` : '—'} delta="▲ 11% vs avg" color={C.green} />
        <StatTile label="Server health" value={kpis ? `${(kpis.serverHealth * 100).toFixed(1)}%` : '—'} delta="all regions nominal" color={C.green} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20 }}>
        <Card>
          <SectionTitle>Revenue — last 7 days (USD)</SectionTitle>
          <BarChart data={revenue.map((r) => ({ label: r.day, value: r.revenue }))} height={170} />
        </Card>
        <Card>
          <SectionTitle>Regions</SectionTitle>
          {[['NA-East', 0.99, C.green], ['EU-West', 0.98, C.green], ['Asia-SE', 0.97, C.green], ['ME-Central', 0.995, C.green], ['SA-East', 0.94, C.accent]].map(([r, h, col]) => (
            <div key={r as string} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0' }}>
              <span style={{ width: 90, fontSize: 13, color: C.dim }}>{r as string}</span>
              <div style={{ flex: 1, height: 6, background: '#1b2430', borderRadius: 4 }}>
                <div style={{ width: `${(h as number) * 100}%`, height: '100%', background: col as string, borderRadius: 4 }} />
              </div>
              <span style={{ fontSize: 12, color: col as string }}>{((h as number) * 100).toFixed(0)}%</span>
            </div>
          ))}
        </Card>
      </div>

      <Card>
        <SectionTitle>Recently active players</SectionTitle>
        <PlayerTable players={players.slice(0, 6)} />
      </Card>
    </div>
  )
}

// ---------------- Players ----------------

export function Players({ players, setStatus }: { players: Player[]; setStatus: (id: string, s: PlayerStatus) => void }) {
  const [q, setQ] = useState('')
  const filtered = players.filter((p) => p.username.toLowerCase().includes(q.toLowerCase()) || p.email.includes(q.toLowerCase()))
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search players by name or email…"
          style={{ flex: 1, maxWidth: 360, padding: '9px 12px', borderRadius: 8, background: '#0b0f14', border: `1px solid ${C.border}`, color: C.text, fontSize: 13 }}
        />
        <span style={{ color: C.dim, fontSize: 13 }}>{filtered.length} players</span>
      </div>
      <PlayerTable players={filtered} actions setStatus={setStatus} />
    </Card>
  )
}

function PlayerTable({ players, actions, setStatus }: { players: Player[]; actions?: boolean; setStatus?: (id: string, s: PlayerStatus) => void }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ color: C.dim, textAlign: 'left' }}>
            {['Player', 'Level', 'K/D', 'Wins', 'Matches', 'Status', 'Last seen', actions ? 'Actions' : ''].map((h) => (
              <th key={h} style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border}`, fontWeight: 500 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {players.map((p) => (
            <tr key={p.id}>
              <td style={td}>
                <div style={{ fontWeight: 600 }}>{p.username}</div>
                <div style={{ color: C.faint, fontSize: 11 }}>{p.email}</div>
              </td>
              <td style={td}><Badge color={C.blue}>{p.level}</Badge></td>
              <td style={td}>{p.kills}/{p.matches - p.wins}</td>
              <td style={td}>{p.wins}</td>
              <td style={td}>{p.matches}</td>
              <td style={td}>{statusBadge(p.status)}</td>
              <td style={{ ...td, color: C.faint }}>{p.lastSeen}</td>
              {actions && (
                <td style={td}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button style={actBtn(C.accent)} onClick={() => setStatus?.(p.id, p.status === 'muted' ? 'active' : 'muted')}>{p.status === 'muted' ? 'Unmute' : 'Mute'}</button>
                    <button style={actBtn(C.red)} onClick={() => setStatus?.(p.id, p.status === 'banned' ? 'active' : 'banned')}>{p.status === 'banned' ? 'Unban' : 'Ban'}</button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------- Leaderboard ----------------

export function Leaderboard({ players }: { players: Player[] }) {
  return (
    <Card>
      <SectionTitle>Global ranking — by XP</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {players.map((p, i) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 12px', borderRadius: 10, background: i < 3 ? '#f0b42910' : '#0e1520', border: `1px solid ${i < 3 ? '#f0b42933' : C.border}` }}>
            <div style={{ width: 28, fontWeight: 700, color: i === 0 ? C.accent : i < 3 ? C.text : C.faint, fontSize: 15 }}>#{i + 1}</div>
            <div style={{ flex: 1, fontWeight: 600 }}>{p.username}</div>
            <Badge color={C.blue}>Lv {p.level}</Badge>
            <div style={{ width: 90, textAlign: 'right', color: C.dim, fontSize: 12 }}>{p.wins} wins</div>
            <div style={{ width: 110, textAlign: 'right', fontWeight: 600 }}>{p.xp.toLocaleString()} XP</div>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ---------------- Economy ----------------

export function Economy({ players }: { players: Player[] }) {
  const [userId, setUserId] = useState(players[0]?.id ?? '')
  const [currency, setCurrency] = useState<'coins' | 'crystals'>('crystals')
  const [amount, setAmount] = useState(500)
  const [log, setLog] = useState<string[]>([])

  function grant() {
    const who = players.find((p) => p.id === userId)?.username ?? userId
    setLog((l) => [`Granted ${amount} ${currency} → ${who}`, ...l].slice(0, 6))
  }

  const items = [
    { id: 'ar_phoenix_gold', name: 'AR Phoenix — Gold', kind: 'skin', price: 1600 },
    { id: 'crate_seasonal', name: 'Seasonal Crate', kind: 'crate', price: 300 },
    { id: 'emote_victory', name: 'Victory Emote', kind: 'emote', price: 450 },
    { id: 'bundle_starter', name: 'Starter Bundle', kind: 'bundle', price: 990 },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
      <Card>
        <SectionTitle>Grant currency</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={lbl}>Player
            <select value={userId} onChange={(e) => setUserId(e.target.value)} style={field}>
              {players.map((p) => <option key={p.id} value={p.id}>{p.username}</option>)}
            </select>
          </label>
          <label style={lbl}>Currency
            <select value={currency} onChange={(e) => setCurrency(e.target.value as 'coins' | 'crystals')} style={field}>
              <option value="crystals">crystals (premium)</option>
              <option value="coins">coins (soft)</option>
            </select>
          </label>
          <label style={lbl}>Amount
            <input type="number" value={amount} onChange={(e) => setAmount(+e.target.value)} style={field} />
          </label>
          <button onClick={grant} style={{ padding: '10px', borderRadius: 8, border: 'none', background: C.accent, color: '#1a1200', fontWeight: 700, cursor: 'pointer' }}>
            Grant (idempotent)
          </button>
          {log.map((l, i) => <div key={i} style={{ fontSize: 12, color: C.green }}>✓ {l}</div>)}
        </div>
      </Card>
      <Card>
        <SectionTitle>Store items</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((it) => (
            <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: '#0e1520', border: `1px solid ${C.border}` }}>
              <div style={{ width: 34, height: 34, borderRadius: 8, background: '#1b2430', display: 'grid', placeItems: 'center' }}>💎</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{it.name}</div>
                <div style={{ color: C.faint, fontSize: 11 }}>{it.kind}</div>
              </div>
              <Badge color={C.purple}>{it.price} 💎</Badge>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

const td: React.CSSProperties = { padding: '10px', borderBottom: `1px solid ${C.border}` }
const lbl: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: C.dim }
const field: React.CSSProperties = { padding: '9px 10px', borderRadius: 8, background: '#0b0f14', border: `1px solid ${C.border}`, color: C.text, fontSize: 13 }
function actBtn(color: string): React.CSSProperties {
  return { padding: '5px 10px', borderRadius: 6, border: `1px solid ${color}55`, background: `${color}18`, color, fontSize: 12, cursor: 'pointer' }
}
