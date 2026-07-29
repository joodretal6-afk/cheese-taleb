import { Controller, Get, Module } from '@nestjs/common'
import { ProfileModule } from './profile/profile.module'

@Controller()
class HealthController {
  @Get('health')
  health(): { status: string; service: string; time: string } {
    return { status: 'ok', service: 'profile', time: new Date().toISOString() }
  }
}

@Module({ imports: [ProfileModule], controllers: [HealthController] })
export class AppModule {}
