import { Controller, Get, Module } from '@nestjs/common'
import { MatchmakingModule } from './matchmaking/matchmaking.module'

@Controller()
class HealthController {
  @Get('health')
  health(): { status: string; service: string; time: string } {
    return { status: 'ok', service: 'matchmaking', time: new Date().toISOString() }
  }
}

@Module({ imports: [MatchmakingModule], controllers: [HealthController] })
export class AppModule {}
