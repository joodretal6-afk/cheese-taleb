/**
 * Battle Pass progression — pure logic. XP maps to tiers; each tier has a free
 * and (optionally) a premium reward. Claim rules are validated here; the service
 * records what's been claimed and grants via Inventory.
 */

export const XP_PER_TIER = 1000
export const MAX_TIER = 100

export type Track = 'free' | 'premium'

export interface Reward {
  itemId: string
  kind: 'skin' | 'emote' | 'crate' | 'currency'
  amount?: number
}

export interface TierRewards {
  tier: number
  free?: Reward
  premium?: Reward
}

/** A compact sample season reward table (every 5th tier gives something bigger). */
export function seasonRewards(): TierRewards[] {
  const rows: TierRewards[] = []
  for (let tier = 1; tier <= MAX_TIER; tier++) {
    const free: Reward | undefined = tier % 5 === 0 ? { itemId: `coins_${tier}`, kind: 'currency', amount: 100 } : undefined
    const premium: Reward =
      tier % 10 === 0
        ? { itemId: `bp_skin_${tier}`, kind: 'skin' }
        : tier % 5 === 0
          ? { itemId: `bp_crate_${tier}`, kind: 'crate' }
          : { itemId: `crystals_${tier}`, kind: 'currency', amount: 20 }
    rows.push({ tier, free, premium })
  }
  return rows
}

export function tierForXp(xp: number): number {
  return Math.max(1, Math.min(MAX_TIER, Math.floor(xp / XP_PER_TIER) + 1))
}

export interface PassProgress {
  userId: string
  xp: number
  premium: boolean
  claimed: Set<string> // keys `${track}:${tier}`
}

export type ClaimDenial = 'tier_not_reached' | 'already_claimed' | 'premium_required' | 'no_reward'

export interface ClaimDecision {
  ok: boolean
  reason?: ClaimDenial
  reward?: Reward
}

export function claimKey(track: Track, tier: number): string {
  return `${track}:${tier}`
}

export function evaluateClaim(progress: PassProgress, tier: number, track: Track): ClaimDecision {
  if (tierForXp(progress.xp) < tier) return { ok: false, reason: 'tier_not_reached' }
  if (track === 'premium' && !progress.premium) return { ok: false, reason: 'premium_required' }
  if (progress.claimed.has(claimKey(track, tier))) return { ok: false, reason: 'already_claimed' }
  const row = seasonRewards().find((r) => r.tier === tier)
  const reward = track === 'free' ? row?.free : row?.premium
  if (!reward) return { ok: false, reason: 'no_reward' }
  return { ok: true, reward }
}
