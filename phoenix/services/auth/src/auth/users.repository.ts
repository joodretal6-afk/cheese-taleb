import { randomUUID } from 'node:crypto'

export interface User {
  id: string
  email: string
  username: string
  passwordHash: string
  createdAt: string
}

export type NewUser = Omit<User, 'id' | 'createdAt'>

/**
 * Storage contract for users. The in-memory implementation below backs tests
 * and local runs; a PostgreSQL implementation (per docs/02-database-schema.md,
 * `auth.users`) drops in behind the same interface without touching the service.
 */
export interface UsersRepository {
  findByEmail(email: string): Promise<User | null>
  findById(id: string): Promise<User | null>
  create(user: NewUser): Promise<User>
}

export const USERS_REPOSITORY = Symbol('USERS_REPOSITORY')

export class InMemoryUsersRepository implements UsersRepository {
  private readonly byId = new Map<string, User>()
  private readonly byEmail = new Map<string, User>()

  async findByEmail(email: string): Promise<User | null> {
    return this.byEmail.get(email.toLowerCase()) ?? null
  }

  async findById(id: string): Promise<User | null> {
    return this.byId.get(id) ?? null
  }

  async create(user: NewUser): Promise<User> {
    const full: User = { ...user, id: randomUUID(), createdAt: new Date().toISOString() }
    this.byId.set(full.id, full)
    this.byEmail.set(full.email.toLowerCase(), full)
    return full
  }
}
