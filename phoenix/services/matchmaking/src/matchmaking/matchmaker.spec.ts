import { formMatches, type MatchmakingConfig, type Ticket } from './matchmaker'

const cfg: MatchmakingConfig = { lobbySize: 4, mmrWindow: 300, maxWaitMs: 30_000, minHumans: 1 }
const t = (userId: string, mmr: number, region = 'na', enqueuedAt = 0): Ticket => ({ userId, mmr, region, enqueuedAt })
const idGen = () => {
  let n = 0
  return () => `m${++n}`
}

describe('formMatches', () => {
  it('forms a full human lobby when enough close-skill players are queued', () => {
    const tickets = [t('a', 1000), t('b', 1050), t('c', 1100), t('d', 1150)]
    const { matches, remaining } = formMatches(tickets, 0, cfg, idGen())
    expect(matches).toHaveLength(1)
    expect(matches[0].players).toHaveLength(4)
    expect(matches[0].humanCount).toBe(4)
    expect(matches[0].players.every((p) => !p.bot)).toBe(true)
    expect(remaining).toHaveLength(0)
  })

  it('keeps players waiting when there are too few and the wait is short', () => {
    const tickets = [t('a', 1000, 'na', 0), t('b', 1050, 'na', 0)]
    const { matches, remaining } = formMatches(tickets, 5_000, cfg, idGen())
    expect(matches).toHaveLength(0)
    expect(remaining).toHaveLength(2)
  })

  it('bot-fills once a ticket has waited past maxWaitMs', () => {
    const tickets = [t('a', 1000, 'na', 0), t('b', 1050, 'na', 0)]
    const { matches, remaining } = formMatches(tickets, 40_000, cfg, idGen())
    expect(matches).toHaveLength(1)
    expect(matches[0].humanCount).toBe(2)
    expect(matches[0].players).toHaveLength(4)
    expect(matches[0].players.filter((p) => p.bot)).toHaveLength(2)
    expect(remaining).toHaveLength(0)
  })

  it('never mixes regions in one lobby', () => {
    const tickets = [t('a', 1000, 'na', 0), t('b', 1000, 'na', 0), t('c', 1000, 'eu', 0), t('d', 1000, 'eu', 0)]
    const { matches } = formMatches(tickets, 40_000, cfg, idGen())
    expect(matches).toHaveLength(2)
    for (const m of matches) {
      expect(new Set(m.players.filter((p) => !p.bot).map(() => m.region)).size).toBe(1)
    }
    expect(matches.map((m) => m.region).sort()).toEqual(['eu', 'na'])
  })

  it('does not put wildly different skill levels in the same lobby', () => {
    // 900 and 2000 are >300 apart, so they cannot share a window.
    const tickets = [t('a', 900, 'na', 0), t('b', 2000, 'na', 0)]
    const { matches } = formMatches(tickets, 40_000, cfg, idGen())
    // Each becomes its own bot-filled lobby, never combined.
    expect(matches.length).toBeGreaterThanOrEqual(1)
    for (const m of matches) {
      const humans = m.players.filter((p) => !p.bot).map((p) => p.mmr)
      const spread = Math.max(...humans) - Math.min(...humans)
      expect(spread).toBeLessThanOrEqual(cfg.mmrWindow)
    }
  })
})
