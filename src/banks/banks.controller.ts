import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { BankListItem, BanksService } from './banks.service';
import { BankNameDto } from './dto/bank-name.dto';

@UseGuards(JwtAuthGuard)
@Controller('banks')
export class BanksController {
  constructor(private readonly banksService: BanksService) {}

  /** POST /banks → 201 Bank (zero counters) | 401. */
  @Post()
  create(
    @CurrentUser() payload: JwtPayload,
    @Body() body: BankNameDto,
  ): Promise<BankListItem> {
    return this.banksService.createBank(payload.sub, body.name);
  }

  /** GET /banks → 200 Bank[] (current host only) | 401. */
  @Get()
  list(@CurrentUser() payload: JwtPayload): Promise<BankListItem[]> {
    return this.banksService.listBanks(payload.sub);
  }
}
