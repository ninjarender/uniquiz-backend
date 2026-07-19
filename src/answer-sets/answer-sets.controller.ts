import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { AnswerSetView } from '../banks/banks.service';
import { AnswerSetsService } from './answer-sets.service';

@UseGuards(JwtAuthGuard)
@Controller('answer-sets')
export class AnswerSetsController {
  constructor(private readonly answerSetsService: AnswerSetsService) {}

  /** POST /answer-sets/{answerSetId}/accept → 200 AnswerSet | 401 | 404 | 409. */
  @Post(':answerSetId/accept')
  @HttpCode(HttpStatus.OK)
  accept(
    @CurrentUser() payload: JwtPayload,
    @Param('answerSetId', ParseUUIDPipe) answerSetId: string,
  ): Promise<AnswerSetView> {
    return this.answerSetsService.acceptAnswerSet(payload.sub, answerSetId);
  }
}
