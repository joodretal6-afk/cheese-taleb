import { Controller, Get, Module } from '@nestjs/common'
import { InventoryModule } from './inventory/inventory.module'

@Controller()
class HealthController {
  @Get('health')
  health(): { status: string; service: string; time: string } {
    return { status: 'ok', service: 'inventory', time: new Date().toISOString() }
  }
}

@Module({ imports: [InventoryModule], controllers: [HealthController] })
export class AppModule {}
