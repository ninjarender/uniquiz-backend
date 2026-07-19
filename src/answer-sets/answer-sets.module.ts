import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GENERATION_QUEUE_CONFIG } from '../generation/generation.constants';
import { AnswerSetsController } from './answer-sets.controller';
import { AnswerSetsService } from './answer-sets.service';

@Module({
  imports: [AuthModule, BullModule.registerQueue(GENERATION_QUEUE_CONFIG)],
  controllers: [AnswerSetsController],
  providers: [AnswerSetsService],
})
export class AnswerSetsModule {}
