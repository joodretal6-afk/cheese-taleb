import { Body, Controller, Get, Param, Post } from '@nestjs/common'
import { IsIn, IsInt, Max, Min } from 'class-validator'
import { BattlePassService, type PassView } from './battlepass.service'
import { MAX_TIER, type Reward, type Track } from './battlepass'

class XpDto {
  @IsInt() @Min(1) amount!: number
}
class ClaimDto {
  @IsInt() @Min(1) @Max(MAX_TIER) tier!: number
  @IsIn(['free', 'premium']) track!: Track
}

@Controller('battlepass')
export class BattlePassController {
  constructor(private readonly bp: BattlePassService) {}

  @Get(':userId')
  get(@Param('userId') userId: string): PassView {
    return this.bp.get(userId)
  }

  @Post(':userId/xp')
  addXp(@Param('userId') userId: string, @Body() dto: XpDto): PassView {
    return this.bp.addXp(userId, dto.amount)
  }

  @Post(':userId/premium')
  premium(@Param('userId') userId: string): PassView {
    return this.bp.activatePremium(userId)
  }

  @Post(':userId/claim')
  claim(@Param('userId') userId: string, @Body() dto: ClaimDto): { reward: Reward } {
    return { reward: this.bp.claim(userId, dto.tier, dto.track) }
  }
}
