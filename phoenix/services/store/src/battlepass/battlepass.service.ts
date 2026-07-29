import { BadRequestException, Injectable } from '@nestjs/common'
import {
  claimKey,
  evaluateClaim,
  tierForXp,
  type PassProgress,
  type Reward,
  type Track,
} from './battlepass'

export interface PassView {
  userId: string
  xp: number
  tier: number
  premium: boolean
  claimed: string[]
}

@Injectable()
export class BattlePassService {
  private readonly progress = new Map<string, PassProgress>()

  private ensure(userId: string): PassProgress {
    let p = this.progress.get(userId)
    if (!p) {
      p = { userId, xp: 0, premium: false, claimed: new Set() }
      this.progress.set(userId, p)
    }
    return p
  }

  get(userId: string): PassView {
    return this.view(this.ensure(userId))
  }

  addXp(userId: string, amount: number): PassView {
    if (amount <= 0) throw new BadRequestException('amount must be positive')
    const p = this.ensure(userId)
    p.xp += amount
    return this.view(p)
  }

  activatePremium(userId: string): PassView {
    const p = this.ensure(userId)
    p.premium = true
    return this.view(p)
  }

  /** Claim a tier reward. Throws with the specific reason on an invalid claim. */
  claim(userId: string, tier: number, track: Track): Reward {
    const p = this.ensure(userId)
    const decision = evaluateClaim(p, tier, track)
    if (!decision.ok || !decision.reward) throw new BadRequestException(decision.reason ?? 'cannot claim')
    p.claimed.add(claimKey(track, tier))
    return decision.reward
  }

  private view(p: PassProgress): PassView {
    return { userId: p.userId, xp: p.xp, tier: tierForXp(p.xp), premium: p.premium, claimed: [...p.claimed] }
  }
}
