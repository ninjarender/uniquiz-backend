import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnswerSetsController } from './answer-sets.controller';
import { AnswerSetsService } from './answer-sets.service';

@Module({
  imports: [AuthModule],
  controllers: [AnswerSetsController],
  providers: [AnswerSetsService],
})
export class AnswerSetsModule {}
