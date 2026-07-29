import { IsInt, IsString, Length, Max, Min } from 'class-validator'

export class CreateProfileDto {
  @IsString()
  @Length(1, 64)
  userId!: string

  @IsString()
  @Length(3, 24)
  displayName!: string
}

export class MatchResultDto {
  @IsInt()
  @Min(0)
  @Max(99)
  kills!: number

  @IsInt()
  @Min(0)
  @Max(1)
  deaths!: number

  @IsInt()
  @Min(0)
  damage!: number

  @IsInt()
  @Min(1)
  @Max(100)
  placement!: number
}
