import { BadRequestException } from '@nestjs/common'
import { MatchmakingService } from './matchmaking.service'

describe('MatchmakingService', () => {
  it('enqueues and reports queue status by region', () => {
    const mm = new MatchmakingService({ lobbySize: 4 })
    mm.enqueue('a', 1000, 'na')
    mm.enqueue('b', 1100, 'na')
    mm.enqueue('c', 1200, 'eu')
    expect(mm.status()).toEqual({ queued: 3, byRegion: { na: 2, eu: 1 } })
  })

  it('rejects a duplicate enqueue', () => {
    const mm = new MatchmakingService()
    mm.enqueue('a', 1000, 'na')
    expect(() => mm.enqueue('a', 1000, 'na')).toThrow(BadRequestException)
  })

  it('cancels a ticket', () => {
    const mm = new MatchmakingService()
    mm.enqueue('a', 1000, 'na')
    expect(mm.cancel('a')).toBe(true)
    expect(mm.status().queued).toBe(0)
    expect(mm.cancel('a')).toBe(false)
  })

  it('pumps a full lobby out of the queue with an injected clock', () => {
    let now = 0
    const mm = new MatchmakingService({ lobbySize: 4 }, () => now)
    mm.enqueue('a', 1000, 'na')
    mm.enqueue('b', 1050, 'na')
    mm.enqueue('c', 1080, 'na')
    mm.enqueue('d', 1120, 'na')

    const matches = mm.pump()
    expect(matches).toHaveLength(1)
    expect(matches[0].humanCount).toBe(4)
    expect(mm.status().queued).toBe(0)
  })

  it('bot-fills a short lobby only after the wait window', () => {
    let now = 0
    const mm = new MatchmakingService({ lobbySize: 4, maxWaitMs: 30_000 }, () => now)
    mm.enqueue('a', 1000, 'na')
    mm.enqueue('b', 1050, 'na')

    expect(mm.pump()).toHaveLength(0) // too soon
    now = 31_000
    const matches = mm.pump()
    expect(matches).toHaveLength(1)
    expect(matches[0].players).toHaveLength(4)
    expect(matches[0].humanCount).toBe(2)
  })
})
