import { Body, Controller, Get, Post } from '@nestjs/common'
import { IsBoolean, IsInt, IsString, Min } from 'class-validator'
import { StoreService } from './store.service'
import type { PurchaseDecision, StoreItem } from './catalog'

class PurchaseDto {
  @IsString() itemId!: string
  // Balance + ownership come from the Inventory service via the gateway.
  @IsInt() @Min(0) balance!: number
  @IsBoolean() alreadyOwned!: boolean
}

@Controller('store')
export class StoreController {
  constructor(private readonly store: StoreService) {}

  @Get('catalog')
  catalog(): StoreItem[] {
    return this.store.catalog()
  }

  @Post('purchase')
  purchase(@Body() dto: PurchaseDto): PurchaseDecision {
    return this.store.purchase(dto.itemId, dto.balance, dto.alreadyOwned)
  }
}
