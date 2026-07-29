import type { Match } from '../matchmaking/matchmaker'
import { toAllocationRequest, validateResultReport, type MatchResultReport } from './session-contract'

const match: Match = {
  id: 'm_1',
  region: 'na',
  players: [
    { userId: 'a', mmr: 1000, bot: false },
    { userId: 'b', mmr: 1050, bot: false },
    { userId: 'bot_1', mmr: 1020, bot: true },
  ],
  avgMmr: 1023,
  humanCount: 2,
}

describe('session contract', () => {
  it('builds an allocation request with a signed join token per player', () => {
    const req = toAllocationRequest(match, 'erangel_clone', (u, m) => `tok-${u}-${m}`)
    expect(req.matchId).toBe('m_1')
    expect(req.region).toBe('na')
    expect(req.mapId).toBe('erangel_clone')
    expect(req.playerCount).toBe(3)
    expect(req.joinTokens).toHaveLength(3)
    expect(req.joinTokens[0]).toEqual({ userId: 'a', token: 'tok-a-m_1', bot: false })
    expect(req.joinTokens.find((t) => t.bot)?.userId).toBe('bot_1')
  })

  it('accepts a well-formed result report', () => {
    const report: MatchResultReport = {
      matchId: 'm_1',
      durationSec: 1420,
      results: [
        { userId: 'a', placement: 1, kills: 6, deaths: 0, damage: 900 },
        { userId: 'b', placement: 2, kills: 3, deaths: 1, damage: 500 },
        { userId: 'bot_1', placement: 3, kills: 1, deaths: 1, damage: 200 },
      ],
    }
    expect(validateResultReport(report, 3)).toEqual([])
  })

  it('flags wrong count, duplicate placement, and negative stats', () => {
    const report: MatchResultReport = {
      matchId: 'm_1',
      durationSec: -5,
      results: [
        { userId: 'a', placement: 1, kills: -2, deaths: 0, damage: 900 },
        { userId: 'b', placement: 1, kills: 3, deaths: 1, damage: 500 },
      ],
    }
    const errors = validateResultReport(report, 3)
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('expected 3 results')]))
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('negative')]))
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('duplicate placement')]))
  })
})
