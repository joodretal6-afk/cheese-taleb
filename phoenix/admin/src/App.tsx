import { useEffect, useMemo, useState } from 'react'
import { api, type Kpis, type Player, type PlayerStatus, type RevenuePoint } from './api'
import { BadgeStatus, Nav, Overview, Players, Leaderboard, Economy } from './pages'

export type Page = 'overview' | 'players' | 'leaderboard' | 'economy'

export function App() {
  const [page, setPage] = useState<Page>('overview')
  const [players, setPlayers] = useState<Player[]>([])
  const [kpis, setKpis] = useState<Kpis | null>(null)
  const [revenue, setRevenue] = useState<RevenuePoint[]>([])

  useEffect(() => {
    void api.kpis().then(setKpis)
    void api.revenueWeek().then(setRevenue)
    void api.players().then(setPlayers)
  }, [])

  function setStatus(id: string, status: PlayerStatus) {
    setPlayers((ps) => ps.map((p) => (p.id === id ? { ...p, status } : p)))
  }

  const leaderboard = useMemo(() => [...players].sort((a, b) => b.xp - a.xp), [players])

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <Nav page={page} setPage={setPage} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <TopBar page={page} online={kpis?.onlineNow ?? 0} />
        <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          {page === 'overview' && <Overview kpis={kpis} revenue={revenue} players={players} />}
          {page === 'players' && <Players players={players} setStatus={setStatus} />}
          {page === 'leaderboard' && <Leaderboard players={leaderboard} />}
          {page === 'economy' && <Economy players={players} />}
        </div>
      </div>
    </div>
  )
}

function TopBar({ page, online }: { page: Page; online: number }) {
  const titles: Record<Page, string> = {
    overview: 'Overview',
    players: 'Player Management',
    leaderboard: 'Leaderboard',
    economy: 'Economy & Store',
  }
  return (
    <div style={{ height: 60, borderBottom: '1px solid #1e2836', display: 'flex', alignItems: 'center', padding: '0 24px', gap: 14, background: '#0e1520' }}>
      <div style={{ fontSize: 17, fontWeight: 600 }}>{titles[page]}</div>
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#8b98a9' }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: '#3fb950', display: 'inline-block' }} />
        {online.toLocaleString()} online
      </div>
      <div style={{ width: 34, height: 34, borderRadius: 999, background: 'linear-gradient(135deg,#f0b429,#a371f7)', display: 'grid', placeItems: 'center', fontWeight: 700, color: '#1a1200', fontSize: 13 }}>
        AD
      </div>
      <BadgeStatus />
    </div>
  )
}
