import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GenerationController } from './generation.controller';
import { GENERATION_QUEUE } from './generation.constants';
import { GenerationService } from './generation.service';

@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: GENERATION_QUEUE })],
  controllers: [GenerationController],
  providers: [GenerationService],
})
export class GenerationModule {}
