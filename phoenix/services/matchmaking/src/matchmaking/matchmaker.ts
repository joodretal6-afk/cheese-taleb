/**
 * Pure matchmaking core. Skill-based, region-aware lobby formation with
 * bot-fill once a ticket has waited long enough. No I/O, no clock — the caller
 * passes `now` and a match-id sequence, so it is fully deterministic and tested
 * independently of NestJS.
 */

export interface Ticket {
  userId: string
  mmr: number
  region: string
  enqueuedAt: number // epoch ms
}

export interface MatchPlayer {
  userId: string
  mmr: number
  bot: boolean
}

export interface Match {
  id: string
  region: string
  players: MatchPlayer[]
  avgMmr: number
  humanCount: number
}

export interface MatchmakingConfig {
  lobbySize: number // players per match (e.g. 100 for BR)
  mmrWindow: number // max MMR spread inside one lobby
  maxWaitMs: number // after this wait, fill the lobby with bots
  /** Minimum humans before a bot-filled lobby is allowed to launch. */
  minHumans: number
}

export const DEFAULT_CONFIG: MatchmakingConfig = {
  lobbySize: 100,
  mmrWindow: 300,
  maxWaitMs: 30_000,
  minHumans: 1,
}

export interface FormResult {
  matches: Match[]
  remaining: Ticket[]
}

let botCounter = 0
function makeBot(mmr: number): MatchPlayer {
  botCounter += 1
  return { userId: `bot_${botCounter}`, mmr, bot: true }
}

function buildMatch(id: string, region: string, humans: Ticket[], botFill: number): Match {
  const players: MatchPlayer[] = humans.map((t) => ({ userId: t.userId, mmr: t.mmr, bot: false }))
  const baseMmr = players.length ? players.reduce((s, p) => s + p.mmr, 0) / players.length : 1000
  for (let i = 0; i < botFill; i++) {
    // Spread bot MMR around the human average so the lobby feels fair.
    players.push(makeBot(Math.round(baseMmr + (i % 2 === 0 ? 1 : -1) * (i * 3))))
  }
  const avgMmr = Math.round(players.reduce((s, p) => s + p.mmr, 0) / players.length)
  return { id, region, players, avgMmr, humanCount: humans.length }
}

export function formMatches(
  tickets: Ticket[],
  now: number,
  config: MatchmakingConfig,
  nextId: () => string,
): FormResult {
  const matches: Match[] = []
  const remaining: Ticket[] = []

  const byRegion = new Map<string, Ticket[]>()
  for (const t of tickets) {
    const list = byRegion.get(t.region) ?? []
    list.push(t)
    byRegion.set(t.region, list)
  }

  for (const [region, list] of byRegion) {
    list.sort((a, b) => a.mmr - b.mmr)
    let i = 0
    while (i < list.length) {
      const base = list[i]
      const window: Ticket[] = []
      let j = i
      while (j < list.length && window.length < config.lobbySize && list[j].mmr - base.mmr <= config.mmrWindow) {
        window.push(list[j])
        j++
      }

      if (window.length >= config.lobbySize) {
        matches.push(buildMatch(nextId(), region, window.slice(0, config.lobbySize), 0))
        i += config.lobbySize
        continue
      }

      const oldestWait = now - Math.min(...window.map((t) => t.enqueuedAt))
      if (oldestWait >= config.maxWaitMs && window.length >= config.minHumans) {
        matches.push(buildMatch(nextId(), region, window, config.lobbySize - window.length))
        i = j
        continue
      }

      // Not enough players and not waited long enough — keep waiting.
      for (let k = i; k < j; k++) remaining.push(list[k])
      i = j
    }
  }

  return { matches, remaining }
}
