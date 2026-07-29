import { ConflictException, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { AuthService } from './auth.service'
import { InMemoryUsersRepository } from './users.repository'

describe('AuthService', () => {
  let service: AuthService
  let jwt: JwtService

  const valid = { email: 'Ace@Phoenix.gg', username: 'ace_01', password: 'sup3r-secret' }

  beforeEach(() => {
    jwt = new JwtService({ secret: 'test-secret' })
    service = new AuthService(new InMemoryUsersRepository(), jwt)
  })

  it('registers a new user and returns a verifiable access token', async () => {
    const res = await service.register(valid)

    expect(res.user.email).toBe('ace@phoenix.gg') // normalised to lowercase
    expect(res.user.username).toBe('ace_01')
    expect(res.user).not.toHaveProperty('passwordHash')
    expect(res.expiresIn).toBeGreaterThan(0)

    const payload = jwt.verify<{ sub: string; username: string }>(res.accessToken)
    expect(payload.sub).toBe(res.user.id)
    expect(payload.username).toBe('ace_01')
  })

  it('rejects a duplicate email', async () => {
    await service.register(valid)
    await expect(service.register({ ...valid, username: 'other' })).rejects.toBeInstanceOf(ConflictException)
  })

  it('logs in with correct credentials', async () => {
    const reg = await service.register(valid)
    const res = await service.login({ email: valid.email, password: valid.password })
    expect(res.user.id).toBe(reg.user.id)
    expect(res.accessToken).toEqual(expect.any(String))
  })

  it('rejects a wrong password', async () => {
    await service.register(valid)
    await expect(service.login({ email: valid.email, password: 'wrong-password' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })

  it('rejects an unknown email', async () => {
    await expect(service.login({ email: 'nobody@phoenix.gg', password: 'whatever0' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })

  it('returns the public profile for a valid user id', async () => {
    const reg = await service.register(valid)
    const me = await service.me(reg.user.id)
    expect(me).toEqual(reg.user)
  })

  it('rejects me() for an unknown id', async () => {
    await expect(service.me('does-not-exist')).rejects.toBeInstanceOf(UnauthorizedException)
  })
})
