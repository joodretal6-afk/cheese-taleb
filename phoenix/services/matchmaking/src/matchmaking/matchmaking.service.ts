import { BadRequestException, Injectable } from '@nestjs/common'
import {
  DEFAULT_CONFIG,
  formMatches,
  type Match,
  type MatchmakingConfig,
  type Ticket,
} from './matchmaker'

export interface QueueStatus {
  queued: number
  byRegion: Record<string, number>
}

/**
 * Holds the live matchmaking queue and forms matches on demand. In production a
 * ticker (or Kafka-driven loop) calls `pump()` on an interval; the dedicated-
 * server allocator then spins up a game server per returned Match. Here `pump()`
 * is called explicitly (and in tests) with an injectable clock.
 */
@Injectable()
export class MatchmakingService {
  private tickets: Ticket[] = []
  private seq = 0
  private readonly config: MatchmakingConfig

  constructor(config: Partial<MatchmakingConfig> = {}, private readonly clock: () => number = Date.now) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  enqueue(userId: string, mmr: number, region: string): void {
    if (this.tickets.some((t) => t.userId === userId)) {
      throw new BadRequestException('Already in queue')
    }
    this.tickets.push({ userId, mmr, region, enqueuedAt: this.clock() })
  }

  cancel(userId: string): boolean {
    const before = this.tickets.length
    this.tickets = this.tickets.filter((t) => t.userId !== userId)
    return this.tickets.length < before
  }

  status(): QueueStatus {
    const byRegion: Record<string, number> = {}
    for (const t of this.tickets) byRegion[t.region] = (byRegion[t.region] ?? 0) + 1
    return { queued: this.tickets.length, byRegion }
  }

  /** Form as many matches as possible right now; matched tickets leave the queue. */
  pump(): Match[] {
    const { matches, remaining } = formMatches(this.tickets, this.clock(), this.config, () => `m_${++this.seq}`)
    this.tickets = remaining
    return matches
  }
}
