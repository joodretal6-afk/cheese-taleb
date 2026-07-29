import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcryptjs'
import type { AuthResult, LoginDto, PublicUser, RegisterDto } from './dto/auth.dto'
import { USERS_REPOSITORY, type User, type UsersRepository } from './users.repository'

/** Access-token lifetime in seconds (15 minutes). Refresh tokens are issued by
 * a separate flow in the full design (docs/08-security-anticheat.md). */
export const ACCESS_TOKEN_TTL = 15 * 60

@Injectable()
export class AuthService {
  constructor(
    @Inject(USERS_REPOSITORY) private readonly users: UsersRepository,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.users.findByEmail(dto.email)
    if (existing) throw new ConflictException('An account with this email already exists')

    const passwordHash = await bcrypt.hash(dto.password, 10)
    const user = await this.users.create({
      email: dto.email.toLowerCase(),
      username: dto.username,
      passwordHash,
    })
    return this.issue(user)
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.users.findByEmail(dto.email)
    // Always run a compare (even on a miss) so timing doesn't reveal which
    // emails exist.
    const ok = user ? await bcrypt.compare(dto.password, user.passwordHash) : await bcrypt.compare(dto.password, DUMMY_HASH)
    if (!user || !ok) throw new UnauthorizedException('Invalid email or password')
    return this.issue(user)
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId)
    if (!user) throw new UnauthorizedException()
    return toPublic(user)
  }

  private issue(user: User): AuthResult {
    const accessToken = this.jwt.sign(
      { sub: user.id, username: user.username, email: user.email },
      { expiresIn: ACCESS_TOKEN_TTL },
    )
    return { user: toPublic(user), accessToken, expiresIn: ACCESS_TOKEN_TTL }
  }
}

function toPublic(user: User): PublicUser {
  return { id: user.id, email: user.email, username: user.username, createdAt: user.createdAt }
}

// A fixed bcrypt hash of a random string, used only to equalise login timing.
const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8oQm3W3n1Z5oQ2rQ1mQe6qgk1o7pS'
