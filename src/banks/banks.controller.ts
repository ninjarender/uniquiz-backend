import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { BankDetailed, BankListItem, BanksService } from './banks.service';
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

  /** GET /banks/{bankId} → 200 BankDetailed | 401 | 404 (foreign = missing). */
  @Get(':bankId')
  get(
    @CurrentUser() payload: JwtPayload,
    @Param('bankId', ParseUUIDPipe) bankId: string,
  ): Promise<BankDetailed> {
    return this.banksService.getBank(payload.sub, bankId);
  }
}
