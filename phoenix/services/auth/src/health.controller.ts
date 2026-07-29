import { Controller, Get } from '@nestjs/common'

@Controller()
export class HealthController {
  @Get('health')
  health(): { status: string; service: string; time: string } {
    return { status: 'ok', service: 'auth', time: new Date().toISOString() }
  }
}
