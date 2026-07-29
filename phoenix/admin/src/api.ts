/**
 * Admin API client.
 *
 * Each call targets the real Phoenix services (auth :4001, profile :4002,
 * inventory :4003) through the admin gateway, and falls back to a seeded demo
 * dataset when the backend is unreachable — so the dashboard renders and can be
 * developed/screenshotted without the whole stack running. `DEMO` is also the
 * shape the live endpoints return.
 */

export type PlayerStatus = 'active' | 'banned' | 'muted'

export interface Player {
  id: string
  username: string
  email: string
  level: number
  xp: number
  kills: number
  wins: number
  matches: number
  status: PlayerStatus
  lastSeen: string
}

export interface Kpis {
  onlineNow: number
  dailyActive: number
  matchesToday: number
  revenueToday: number
  serverHealth: number // 0..1
}

export interface RevenuePoint {
  day: string
  revenue: number
}

const NAMES = [
  'FalconStrike', 'DesertWolf', 'NovaByte', 'IronVortex', 'GhostEmber', 'RazorKite',
  'SandViper', 'BlazeQuill', 'CobaltFox', 'NightHawk', 'ThornJinn', 'VoltReaper',
  'AtlasRift', 'EchoMirage', 'DuskFalcon', ' zealot ', 'PhantomAce', 'Gale',
]

function seededPlayers(): Player[] {
  let seed = 20260729
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  return NAMES.map((n, i) => {
    const matches = 20 + Math.floor(rnd() * 900)
    const wins = Math.floor(matches * (0.05 + rnd() * 0.25))
    const kills = Math.floor(matches * (1 + rnd() * 5))
    const xp = 400 + Math.floor(rnd() * 90000)
    const status: PlayerStatus = i === 15 ? 'banned' : i === 7 ? 'muted' : 'active'
    return {
      id: `u_${1000 + i}`,
      username: n.trim(),
      email: `${n.trim().toLowerCase()}@phoenix.gg`,
      level: Math.floor(Math.sqrt(xp / 100)) + 1,
      xp,
      kills,
      wins,
      matches,
      status,
      lastSeen: `${Math.floor(rnd() * 59) + 1}m ago`,
    }
  })
}

const DEMO_PLAYERS = seededPlayers()

const DEMO_KPIS: Kpis = {
  onlineNow: 48213,
  dailyActive: 612940,
  matchesToday: 89412,
  revenueToday: 42875,
  serverHealth: 0.985,
}

const DEMO_REVENUE: RevenuePoint[] = [
  ['Mon', 31200], ['Tue', 35800], ['Wed', 33100], ['Thu', 40200], ['Fri', 52600], ['Sat', 61840], ['Sun', 42875],
].map(([day, revenue]) => ({ day: day as string, revenue: revenue as number }))

async function tryFetch<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) throw new Error(String(res.status))
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

export const api = {
  gateway: (import.meta as unknown as { env?: { VITE_API?: string } }).env?.VITE_API ?? 'http://127.0.0.1:4002',

  async kpis(): Promise<Kpis> {
    return tryFetch(`${this.gateway}/admin/kpis`, DEMO_KPIS)
  },
  async revenueWeek(): Promise<RevenuePoint[]> {
    return tryFetch(`${this.gateway}/admin/revenue`, DEMO_REVENUE)
  },
  async players(): Promise<Player[]> {
    return tryFetch(`${this.gateway}/admin/players`, DEMO_PLAYERS)
  },
  async leaderboard(): Promise<Player[]> {
    const list = await this.players()
    return [...list].sort((a, b) => b.xp - a.xp)
  },
}
