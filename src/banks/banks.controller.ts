import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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

  /** PATCH /banks/{bankId} → 200 updated Bank | 401 | 404. */
  @Patch(':bankId')
  rename(
    @CurrentUser() payload: JwtPayload,
    @Param('bankId', ParseUUIDPipe) bankId: string,
    @Body() body: BankNameDto,
  ): Promise<BankListItem> {
    return this.banksService.renameBank(payload.sub, bankId, body.name);
  }

  /** DELETE /banks/{bankId} → 204 (cascade) | 401 | 404. */
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':bankId')
  remove(
    @CurrentUser() payload: JwtPayload,
    @Param('bankId', ParseUUIDPipe) bankId: string,
  ): Promise<void> {
    return this.banksService.deleteBank(payload.sub, bankId);
  }
}
