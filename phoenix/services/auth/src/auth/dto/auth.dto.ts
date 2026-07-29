import { IsEmail, IsString, Length, Matches } from 'class-validator'

export class RegisterDto {
  @IsEmail()
  email!: string

  @IsString()
  @Length(3, 20)
  @Matches(/^[a-zA-Z0-9_]+$/, { message: 'username may only contain letters, numbers and underscore' })
  username!: string

  @IsString()
  @Length(8, 128)
  password!: string
}

export class LoginDto {
  @IsEmail()
  email!: string

  @IsString()
  @Length(8, 128)
  password!: string
}

export interface PublicUser {
  id: string
  email: string
  username: string
  createdAt: string
}

export interface AuthResult {
  user: PublicUser
  accessToken: string
  expiresIn: number
}
