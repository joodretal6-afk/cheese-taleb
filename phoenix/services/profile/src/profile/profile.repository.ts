export interface ProfileStats {
  matches: number
  wins: number
  kills: number
  deaths: number
  damage: number
}

export interface Profile {
  userId: string
  displayName: string
  xp: number
  stats: ProfileStats
  createdAt: string
  updatedAt: string
}

export const PROFILE_REPOSITORY = Symbol('PROFILE_REPOSITORY')

export interface ProfileRepository {
  findByUserId(userId: string): Promise<Profile | null>
  save(profile: Profile): Promise<Profile>
  all(): Promise<Profile[]>
}

export function emptyStats(): ProfileStats {
  return { matches: 0, wins: 0, kills: 0, deaths: 0, damage: 0 }
}

export class InMemoryProfileRepository implements ProfileRepository {
  private readonly byUser = new Map<string, Profile>()

  async findByUserId(userId: string): Promise<Profile | null> {
    return this.byUser.get(userId) ?? null
  }

  async save(profile: Profile): Promise<Profile> {
    this.byUser.set(profile.userId, profile)
    return profile
  }

  async all(): Promise<Profile[]> {
    return [...this.byUser.values()]
  }
}
