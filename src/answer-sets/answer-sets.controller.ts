import {
  Body,
  Controller,
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
import { AnswerSetView } from '../banks/banks.service';
import { AnswerSetsService } from './answer-sets.service';
import { AnswerSetPatchDto } from './dto/answer-set-patch.dto';

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

  /** POST /answer-sets/{answerSetId}/regenerate → 202 AnswerSet | 401 | 404 | 409. */
  @Post(':answerSetId/regenerate')
  @HttpCode(HttpStatus.ACCEPTED)
  regenerate(
    @CurrentUser() payload: JwtPayload,
    @Param('answerSetId', ParseUUIDPipe) answerSetId: string,
  ): Promise<AnswerSetView> {
    return this.answerSetsService.regenerateAnswerSet(payload.sub, answerSetId);
  }

  /** PATCH /answer-sets/{answerSetId} → 200 AnswerSet | 400 | 401 | 404. */
  @Patch(':answerSetId')
  update(
    @CurrentUser() payload: JwtPayload,
    @Param('answerSetId', ParseUUIDPipe) answerSetId: string,
    @Body() body: AnswerSetPatchDto,
  ): Promise<AnswerSetView> {
    return this.answerSetsService.updateAnswerSet(
      payload.sub,
      answerSetId,
      body,
    );
  }
}
