import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common'
import { IsInt, IsString, Length, Max, Min } from 'class-validator'
import { MatchmakingService, type QueueStatus } from './matchmaking.service'
import type { Match } from './matchmaker'

class EnqueueDto {
  @IsString() @Length(1, 64) userId!: string
  @IsInt() @Min(0) @Max(6000) mmr!: number
  @IsString() @Length(2, 24) region!: string
}

@Controller('queue')
export class MatchmakingController {
  constructor(private readonly mm: MatchmakingService) {}

  @Post()
  @HttpCode(202)
  enqueue(@Body() dto: EnqueueDto): { status: 'queued' } {
    this.mm.enqueue(dto.userId, dto.mmr, dto.region)
    return { status: 'queued' }
  }

  @Delete(':userId')
  cancel(@Param('userId') userId: string): { cancelled: boolean } {
    return { cancelled: this.mm.cancel(userId) }
  }

  @Get('status')
  status(): QueueStatus {
    return this.mm.status()
  }

  @Post('pump')
  pump(): { matches: Match[] } {
    return { matches: this.mm.pump() }
  }
}
