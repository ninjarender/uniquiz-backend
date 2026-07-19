import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GeminiService } from './gemini.service';
import { GenerationController } from './generation.controller';
import { GENERATION_QUEUE_CONFIG } from './generation.constants';
import { GenerationProcessor } from './generation.processor';
import { GenerationService } from './generation.service';

@Module({
  imports: [AuthModule, BullModule.registerQueue(GENERATION_QUEUE_CONFIG)],
  controllers: [GenerationController],
  providers: [GenerationService, GeminiService, GenerationProcessor],
})
export class GenerationModule {}
