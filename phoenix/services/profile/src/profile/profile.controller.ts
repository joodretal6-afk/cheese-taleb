import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { CreateProfileDto, MatchResultDto } from './dto'
import { ProfileService, type ProfileView } from './profile.service'

@Controller()
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Post('profiles')
  create(@Body() dto: CreateProfileDto): Promise<ProfileView> {
    return this.profiles.create(dto.userId, dto.displayName)
  }

  @Get('profiles/:userId')
  get(@Param('userId') userId: string): Promise<ProfileView> {
    return this.profiles.get(userId)
  }

  @Post('profiles/:userId/match')
  recordMatch(@Param('userId') userId: string, @Body() dto: MatchResultDto): Promise<ProfileView> {
    return this.profiles.recordMatch(userId, dto)
  }

  @Get('leaderboard')
  leaderboard(@Query('limit') limit?: string): Promise<ProfileView[]> {
    return this.profiles.leaderboard(limit ? Number(limit) : 10)
  }
}
