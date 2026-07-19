import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GENERATION_QUEUE } from '../generation/generation.constants';
import { AnswerSetsController } from './answer-sets.controller';
import { AnswerSetsService } from './answer-sets.service';

@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: GENERATION_QUEUE })],
  controllers: [AnswerSetsController],
  providers: [AnswerSetsService],
})
export class AnswerSetsModule {}
