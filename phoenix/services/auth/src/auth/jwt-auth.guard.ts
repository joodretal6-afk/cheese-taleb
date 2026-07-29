import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import type { Request } from 'express'

/** Validates the `Authorization: Bearer <token>` header and stashes the user id. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { userId?: string }>()
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token')
    try {
      const payload = this.jwt.verify<{ sub: string }>(header.slice(7))
      req.userId = payload.sub
      return true
    } catch {
      throw new UnauthorizedException('Invalid or expired token')
    }
  }
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | undefined => {
  const req = ctx.switchToHttp().getRequest<{ userId?: string }>()
  return req.userId
})
