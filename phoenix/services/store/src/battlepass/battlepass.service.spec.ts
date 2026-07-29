import { BadRequestException } from '@nestjs/common'
import { BattlePassService } from './battlepass.service'
import { tierForXp, XP_PER_TIER } from './battlepass'

describe('battlepass tiers', () => {
  it('maps xp to tiers', () => {
    expect(tierForXp(0)).toBe(1)
    expect(tierForXp(XP_PER_TIER * 4)).toBe(5)
  })
})

describe('BattlePassService', () => {
  let bp: BattlePassService
  beforeEach(() => {
    bp = new BattlePassService()
  })

  it('starts at tier 1, free track, no premium', () => {
    const v = bp.get('u1')
    expect(v.tier).toBe(1)
    expect(v.premium).toBe(false)
    expect(v.claimed).toEqual([])
  })

  it('advances tiers as XP is added', () => {
    const v = bp.addXp('u1', XP_PER_TIER * 9) // tier 10
    expect(v.tier).toBe(10)
  })

  it('claims a reached free reward once, then rejects a re-claim', () => {
    bp.addXp('u1', XP_PER_TIER * 5) // tier 6, so tier 5 reward is available
    const reward = bp.claim('u1', 5, 'free')
    expect(reward.kind).toBe('currency')
    expect(() => bp.claim('u1', 5, 'free')).toThrow(BadRequestException)
  })

  it('rejects claiming a tier not yet reached', () => {
    expect(() => bp.claim('u1', 40, 'free')).toThrow(BadRequestException)
  })

  it('requires premium for the premium track', () => {
    bp.addXp('u1', XP_PER_TIER * 10) // tier 11
    expect(() => bp.claim('u1', 10, 'premium')).toThrow(BadRequestException) // no premium yet
    bp.activatePremium('u1')
    const reward = bp.claim('u1', 10, 'premium')
    expect(reward.kind).toBe('skin') // tier 10 premium is a skin
  })
})
