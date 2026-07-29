import { IsIn, IsInt, IsOptional, IsPositive, IsString, Length } from 'class-validator'
import type { Currency, ItemKind } from './store'

const KINDS: ItemKind[] = ['weapon', 'skin', 'attachment', 'emote', 'crate']
const CURRENCIES: Currency[] = ['coins', 'crystals']

export class GrantDto {
  @IsString() @Length(1, 64) itemId!: string
  @IsIn(KINDS) kind!: ItemKind
  @IsOptional() @IsInt() @IsPositive() quantity?: number
  @IsOptional() @IsString() idempotencyKey?: string
}

export class WalletDto {
  @IsIn(CURRENCIES) currency!: Currency
  @IsInt() @IsPositive() amount!: number
  @IsString() @Length(1, 120) reason!: string
  @IsOptional() @IsString() idempotencyKey?: string
}
