import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ResultsController } from './results.controller';
import { ResultsService } from './results.service';

@Module({
  imports: [AuthModule],
  controllers: [ResultsController],
  providers: [ResultsService],
})
export class ResultsModule {}
