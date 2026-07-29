import { ConflictException, NotFoundException } from '@nestjs/common'
import { InMemoryProfileRepository } from './profile.repository'
import { ProfileService, xpForMatch } from './profile.service'

describe('ProfileService', () => {
  let service: ProfileService

  beforeEach(() => {
    service = new ProfileService(new InMemoryProfileRepository())
  })

  it('creates a profile at level 1 with empty stats', async () => {
    const p = await service.create('u1', 'Falcon')
    expect(p.displayName).toBe('Falcon')
    expect(p.level).toBe(1)
    expect(p.xp).toBe(0)
    expect(p.stats.matches).toBe(0)
  })

  it('rejects a duplicate profile', async () => {
    await service.create('u1', 'Falcon')
    await expect(service.create('u1', 'Falcon2')).rejects.toBeInstanceOf(ConflictException)
  })

  it('throws when fetching a missing profile', async () => {
    await expect(service.get('nope')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('records a winning match: stats and XP go up, level rises', async () => {
    await service.create('u1', 'Falcon')
    const result = { kills: 8, deaths: 0, damage: 1200, placement: 1 }
    const p = await service.recordMatch('u1', result)

    expect(p.stats.matches).toBe(1)
    expect(p.stats.wins).toBe(1)
    expect(p.stats.kills).toBe(8)
    expect(p.stats.damage).toBe(1200)
    expect(p.xp).toBe(xpForMatch(result))
    expect(p.level).toBeGreaterThan(1)
  })

  it('does not count a loss as a win', async () => {
    await service.create('u1', 'Falcon')
    const p = await service.recordMatch('u1', { kills: 2, deaths: 1, damage: 300, placement: 17 })
    expect(p.stats.wins).toBe(0)
    expect(p.stats.matches).toBe(1)
  })

  it('ranks the leaderboard by XP', async () => {
    await service.create('a', 'A')
    await service.create('b', 'B')
    await service.create('c', 'C')
    await service.recordMatch('a', { kills: 1, deaths: 0, damage: 100, placement: 40 })
    await service.recordMatch('b', { kills: 12, deaths: 0, damage: 2500, placement: 1 })
    await service.recordMatch('c', { kills: 4, deaths: 1, damage: 800, placement: 5 })

    const board = await service.leaderboard()
    expect(board.map((p) => p.userId)).toEqual(['b', 'c', 'a'])
  })
})
