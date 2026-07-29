/**
 * Dedicated-server session contract.
 *
 * The messages exchanged when a formed Match is handed to the game-server fleet
 * (Agones, per docs/07-devops-infra.md) and back. Both the backend and the UE5
 * dedicated server compile against these shapes, so the wire format has one
 * source of truth. Pure types + validators — no transport here.
 */

import type { Match } from '../matchmaking/matchmaker'

export type ServerRegion = string

/** Backend → allocator: "please host this match". */
export interface AllocationRequest {
  matchId: string
  region: ServerRegion
  mapId: string
  playerCount: number
  /** Per-player join tokens the client presents to the dedicated server. */
  joinTokens: JoinToken[]
}

export interface JoinToken {
  userId: string
  token: string // signed, short-lived
  bot: boolean
}

/** Allocator → backend: where the match is hosted. */
export interface AllocationResult {
  matchId: string
  host: string
  port: number
  status: 'allocated' | 'starting' | 'ready'
}

/** Dedicated server → backend, once the match ends. Drives Ranking/Stats/Inventory. */
export interface MatchResultReport {
  matchId: string
  durationSec: number
  results: PlayerMatchResult[]
}

export interface PlayerMatchResult {
  userId: string
  placement: number
  kills: number
  deaths: number
  damage: number
}

/** Build an allocation request from a formed match. `sign` mints a join token. */
export function toAllocationRequest(
  match: Match,
  mapId: string,
  sign: (userId: string, matchId: string) => string,
): AllocationRequest {
  return {
    matchId: match.id,
    region: match.region,
    mapId,
    playerCount: match.players.length,
    joinTokens: match.players.map((p) => ({ userId: p.userId, token: sign(p.userId, match.id), bot: p.bot })),
  }
}

/** Validate a result report before it mutates player stats — reject malformed or
 * out-of-range payloads (a defence-in-depth check on top of server auth). */
export function validateResultReport(report: MatchResultReport, expectedPlayers: number): string[] {
  const errors: string[] = []
  if (!report.matchId) errors.push('missing matchId')
  if (report.durationSec < 0) errors.push('negative duration')
  if (report.results.length !== expectedPlayers) {
    errors.push(`expected ${expectedPlayers} results, got ${report.results.length}`)
  }
  const placements = new Set<number>()
  for (const r of report.results) {
    if (r.placement < 1 || r.placement > expectedPlayers) errors.push(`bad placement ${r.placement} for ${r.userId}`)
    if (r.kills < 0 || r.deaths < 0 || r.damage < 0) errors.push(`negative stat for ${r.userId}`)
    if (placements.has(r.placement)) errors.push(`duplicate placement ${r.placement}`)
    placements.add(r.placement)
  }
  return errors
}
