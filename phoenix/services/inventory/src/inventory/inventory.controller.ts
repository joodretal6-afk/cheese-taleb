import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { GrantDto, WalletDto } from './dto'
import { InventoryService } from './inventory.service'
import type { Currency, OwnedItem } from './store'

@Controller()
export class InventoryController {
  constructor(private readonly inv: InventoryService) {}

  @Get('inventory/:userId')
  list(@Param('userId') userId: string): OwnedItem[] {
    return this.inv.list(userId)
  }

  @Post('inventory/:userId/grant')
  grant(@Param('userId') userId: string, @Body() dto: GrantDto): OwnedItem {
    return this.inv.grant(userId, dto.itemId, dto.kind, dto.quantity ?? 1, dto.idempotencyKey)
  }

  @Get('wallet/:userId')
  wallet(@Param('userId') userId: string): { coins: number; crystals: number } {
    return { coins: this.inv.balance(userId, 'coins'), crystals: this.inv.balance(userId, 'crystals') }
  }

  @Post('wallet/:userId/credit')
  credit(@Param('userId') userId: string, @Body() dto: WalletDto): { balance: number } {
    return { balance: this.inv.credit(userId, dto.currency, dto.amount, dto.reason, dto.idempotencyKey) }
  }

  @Post('wallet/:userId/debit')
  debit(@Param('userId') userId: string, @Body() dto: WalletDto): { balance: number } {
    return { balance: this.inv.debit(userId, dto.currency, dto.amount, dto.reason) }
  }

  @Get('inventory/:userId/owns')
  owns(@Param('userId') userId: string, @Query('itemId') itemId: string): { owned: boolean } {
    return { owned: this.inv.owns(userId, itemId) }
  }
}
