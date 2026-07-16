import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { BankListItem, BanksService } from './banks.service';

@UseGuards(JwtAuthGuard)
@Controller('banks')
export class BanksController {
  constructor(private readonly banksService: BanksService) {}

  /** GET /banks → 200 Bank[] (current host only) | 401. */
  @Get()
  list(@CurrentUser() payload: JwtPayload): Promise<BankListItem[]> {
    return this.banksService.listBanks(payload.sub);
  }
}
