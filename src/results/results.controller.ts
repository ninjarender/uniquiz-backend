import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { GameResultView, ResultsService } from './results.service';

@UseGuards(JwtAuthGuard)
@Controller('game-results')
export class ResultsController {
  constructor(private readonly resultsService: ResultsService) {}

  /** GET /game-results → 200 GameResult[] (current host, newest first) | 401. */
  @Get()
  list(@CurrentUser() payload: JwtPayload): Promise<GameResultView[]> {
    return this.resultsService.listGameResults(payload.sub);
  }
}
