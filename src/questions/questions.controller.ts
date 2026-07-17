import {
  Body,
  Controller,
  Delete,
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
import { QuestionView } from '../banks/banks.service';
import { CreateQuestionDto, UpdateQuestionDto } from './dto/question-input.dto';
import { QuestionsService } from './questions.service';

@UseGuards(JwtAuthGuard)
@Controller()
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

  /** POST /banks/{bankId}/questions → 201 Question | 401 | 404. */
  @Post('banks/:bankId/questions')
  create(
    @CurrentUser() payload: JwtPayload,
    @Param('bankId', ParseUUIDPipe) bankId: string,
    @Body() body: CreateQuestionDto,
  ): Promise<QuestionView> {
    return this.questionsService.createQuestion(payload.sub, bankId, body);
  }

  /** PATCH /questions/{questionId} → 200 Question | 401 | 404. */
  @Patch('questions/:questionId')
  update(
    @CurrentUser() payload: JwtPayload,
    @Param('questionId', ParseUUIDPipe) questionId: string,
    @Body() body: UpdateQuestionDto,
  ): Promise<QuestionView> {
    return this.questionsService.updateQuestion(payload.sub, questionId, body);
  }

  /** DELETE /questions/{questionId} → 204 (with its answer set) | 401 | 404. */
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('questions/:questionId')
  remove(
    @CurrentUser() payload: JwtPayload,
    @Param('questionId', ParseUUIDPipe) questionId: string,
  ): Promise<void> {
    return this.questionsService.deleteQuestion(payload.sub, questionId);
  }
}
