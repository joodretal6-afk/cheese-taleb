import { Controller, Get, Module } from '@nestjs/common'
import { StoreController } from './store/store.controller'
import { StoreService } from './store/store.service'
import { BattlePassController } from './battlepass/battlepass.controller'
import { BattlePassService } from './battlepass/battlepass.service'

@Controller()
class HealthController {
  @Get('health')
  health(): { status: string; service: string; time: string } {
    return { status: 'ok', service: 'store', time: new Date().toISOString() }
  }
}

@Module({
  controllers: [HealthController, StoreController, BattlePassController],
  providers: [StoreService, BattlePassService],
})
export class AppModule {}
