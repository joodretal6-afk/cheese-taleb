import { Module } from '@nestjs/common'
import { ProfileController } from './profile.controller'
import { ProfileService } from './profile.service'
import { InMemoryProfileRepository, PROFILE_REPOSITORY } from './profile.repository'

@Module({
  controllers: [ProfileController],
  providers: [ProfileService, { provide: PROFILE_REPOSITORY, useClass: InMemoryProfileRepository }],
})
export class ProfileModule {}
