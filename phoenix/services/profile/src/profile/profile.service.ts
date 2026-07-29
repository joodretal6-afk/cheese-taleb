import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { levelForXp, levelProgress, type LevelProgress } from './leveling'
import {
  emptyStats,
  PROFILE_REPOSITORY,
  type Profile,
  type ProfileRepository,
} from './profile.repository'

export interface MatchResult {
  kills: number
  deaths: number
  damage: number
  /** Final placement (1 = winner). */
  placement: number
}

export interface ProfileView extends Profile {
  level: number
  progress: LevelProgress
}

/** XP awarded for a match: base + per-kill + per-damage + a win bonus. */
export function xpForMatch(r: MatchResult): number {
  const placementBonus = r.placement === 1 ? 300 : Math.max(0, 60 - (r.placement - 1) * 4)
  return 25 + r.kills * 20 + Math.floor(r.damage / 10) + placementBonus
}

@Injectable()
export class ProfileService {
  constructor(@Inject(PROFILE_REPOSITORY) private readonly repo: ProfileRepository) {}

  async create(userId: string, displayName: string): Promise<ProfileView> {
    if (await this.repo.findByUserId(userId)) {
      throw new ConflictException('Profile already exists for this user')
    }
    const now = new Date().toISOString()
    const profile: Profile = { userId, displayName, xp: 0, stats: emptyStats(), createdAt: now, updatedAt: now }
    return this.view(await this.repo.save(profile))
  }

  async get(userId: string): Promise<ProfileView> {
    const p = await this.repo.findByUserId(userId)
    if (!p) throw new NotFoundException('Profile not found')
    return this.view(p)
  }

  async recordMatch(userId: string, result: MatchResult): Promise<ProfileView> {
    const p = await this.repo.findByUserId(userId)
    if (!p) throw new NotFoundException('Profile not found')

    p.stats.matches += 1
    p.stats.kills += result.kills
    p.stats.deaths += result.deaths
    p.stats.damage += result.damage
    if (result.placement === 1) p.stats.wins += 1
    p.xp += xpForMatch(result)
    p.updatedAt = new Date().toISOString()

    return this.view(await this.repo.save(p))
  }

  async leaderboard(limit = 10): Promise<ProfileView[]> {
    const all = await this.repo.all()
    return all
      .map((p) => this.view(p))
      .sort((a, b) => b.xp - a.xp || b.stats.wins - a.stats.wins)
      .slice(0, limit)
  }

  private view(p: Profile): ProfileView {
    return { ...p, level: levelForXp(p.xp), progress: levelProgress(p.xp) }
  }
}
