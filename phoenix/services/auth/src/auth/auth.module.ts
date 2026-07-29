import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { JwtAuthGuard } from './jwt-auth.guard'
import { InMemoryUsersRepository, USERS_REPOSITORY } from './users.repository'

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'phoenix-dev-secret-change-me',
      signOptions: { issuer: 'phoenix.auth' },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAuthGuard,
    // Swap InMemoryUsersRepository for a PostgresUsersRepository in production.
    { provide: USERS_REPOSITORY, useClass: InMemoryUsersRepository },
  ],
})
export class AuthModule {}
